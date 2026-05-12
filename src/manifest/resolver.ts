/**
 * Manifest resolver — turns the parsed v5 manifest into a normalised
 * form the runtime can instantiate against.
 *
 * Three jobs:
 *   1. **Shape classification.** A `Reference` is a string (bare handle
 *      or SourceSpec fast-path) or a SourceSpec table; classify it.
 *   2. **Handle lookup.** Bare-handle references resolve against
 *      `[providers]` first, then the slot's built-in registry
 *      (§1.2 of manifest-v5.md). One rule, parameterised by slot.
 *   3. **Anonymous-instance dedup.** Multiple references that resolve
 *      to the same `(resolved source, config)` share one runtime
 *      `Tools` instance (§1.5 of manifest-v5.md).
 *
 * The output is a `ResolvedManifest` — a flat list of provider
 * instances to materialise plus bindings (tools → instance, harness →
 * factory, session → factory). The runtime consumes that without ever
 * touching the on-disk shape again.
 *
 * Also still home to `resolveSystemPrompt` (unchanged).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ManifestError, ResolutionError } from "../errors.js";
import type { Session } from "../types/interfaces.js";
import type {
  AgentManifest,
  HarnessSpec,
  ProviderEntry,
  ProviderEntryTable,
  Reference,
  SessionLayerEntry,
  SessionSpec,
  SourceSpec,
  ToolEntry,
  ToolEntryTable,
} from "../types/manifest.js";

// ─── System prompt (unchanged) ─────────────────────────────────────────────

/**
 * Read `[agent].system_prompt` and return its text. The string form is
 * disambiguated by prefix (`./`, `../`, `/`, `~/` → path; otherwise
 * literal); the structured form `{ path }` is unambiguous and accepted
 * even when the literal would be path-shaped.
 */
export async function resolveSystemPrompt(
  manifest: AgentManifest,
  baseDir: string,
): Promise<string> {
  const v = manifest.systemPrompt;
  if (v === undefined) return "";
  if (typeof v === "object") {
    const p = path.resolve(baseDir, expandHome(v.path));
    return await readSystemPromptFile(p);
  }
  if (looksLikePromptPath(v)) {
    const p = path.resolve(baseDir, expandHome(v));
    return await readSystemPromptFile(p);
  }
  return v;
}

async function readSystemPromptFile(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (e) {
    throw new ResolutionError(
      `Failed to read [agent].system_prompt file at ${p}: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

function looksLikePromptPath(s: string): boolean {
  return (
    s.startsWith("./") ||
    s.startsWith("../") ||
    s.startsWith("/") ||
    s.startsWith("~/")
  );
}

function expandHome(p: string): string {
  if (!p.startsWith("~/")) return p;
  return path.join(process.env.HOME ?? "", p.slice(2));
}

// ─── Reference shape classification ───────────────────────────────────────

/**
 * A bare handle is a string with no `/`, no `@`, no `./` or `../`
 * prefix — i.e., a local identifier resolving to a `[providers]`
 * table entry or a built-in registry name.
 */
export function isBareHandle(s: string): boolean {
  return (
    !s.startsWith("./") &&
    !s.startsWith("../") &&
    !s.startsWith("/") &&
    !s.includes("/")
  );
}

/**
 * Reify a `Reference` as a `SourceSpec` when its shape is SourceSpec-like.
 * Returns null for bare handles. Strings with leading `./` / `../`
 * become `{ path }`; strings containing `/` become `{ npm }`; tables
 * are passed through.
 */
export function referenceToSourceSpec(ref: Reference): SourceSpec | null {
  if (typeof ref === "string") {
    if (ref.startsWith("./") || ref.startsWith("../")) {
      return { path: ref };
    }
    if (ref.includes("/")) {
      return { npm: ref };
    }
    return null;
  }
  return ref;
}

/** Reify a `Reference` as a bare handle, or null if it's a SourceSpec. */
export function referenceToHandle(ref: Reference): string | null {
  if (typeof ref === "string" && isBareHandle(ref)) return ref;
  return null;
}

// ─── Canonical keys (for dedup + lock.toml) ───────────────────────────────

/** Stable structural key for a `SourceSpec`, used for dedup + `lock.toml`. */
export function sourceSpecKey(s: SourceSpec): string {
  if ("npm" in s) return `npm:${s.npm}@${s.version ?? "*"}`;
  if ("path" in s) return `path:${s.path}${s.subpath ? "#" + s.subpath : ""}`;
  return `unknown:${JSON.stringify(s)}`;
}

/**
 * Stable, content-addressed key for a config object. Used to dedup
 * anonymous provider instances that have the same (source, config).
 * Canonicalises by sorting keys; only meaningful for JSON-shaped values.
 */
export function configKey(config: Record<string, unknown>): string {
  return canonicalJsonStringify(config);
}

function canonicalJsonStringify(v: unknown): string {
  if (v === null || v === undefined) return JSON.stringify(v);
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return "[" + v.map(canonicalJsonStringify).join(",") + "]";
  }
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJsonStringify(
            (v as Record<string, unknown>)[k],
          )}`,
      )
      .join(",") +
    "}"
  );
}

// ─── Resolved manifest IR ─────────────────────────────────────────────────

/**
 * Provenance — where in the manifest a provider instance came from.
 * Used for diagnostics and audit output.
 *
 * v5 doesn't distinguish "named" vs. "anonymous via handle" any more
 * — both resolve through `[providers]`, and dedup carries shared
 * instances implicitly via `(source, config)`. The origin variants
 * mostly inform error messages now.
 */
export type ProviderOrigin =
  | { kind: "native" }
  | { kind: "handle-anonymous"; providerHandle: string } // resolved via [providers].<handle> (SourceSpec form)
  | {
      kind: "handle-factory";
      providerHandle: string;
      factoryName: string;
    } // resolved via [providers].<handle> (configured-factory form)
  | { kind: "inline-anonymous"; toolName?: string }; // resolved via inline SourceSpec

/**
 * A `Tools` instance the runtime will materialise. The `id` is
 * stable across references that dedupe to the same instance.
 *
 * Two `kind === "provider"` shapes coexist:
 *
 *   - **Source-backed.** `source` is set; the provider loader
 *     materialises code-on-disk. This is the historical shape.
 *   - **Factory-backed.** `factoryName` is set, `source` is undefined;
 *     the runtime looks up a Tools factory by name (e.g. `"mcp-server"`)
 *     in the built-in registry and calls its `create()` directly.
 *     Used by the configured-factory `[providers]` form.
 */
export interface ProviderInstance {
  /** Stable id used in tool bindings. `"native"` for the built-in. */
  id: string;
  /** `"native"` (the singleton) or `"provider"` (instantiated per-entry). */
  kind: "native" | "provider";
  /** Source-backed providers: SourceSpec the provider loads from. */
  source?: SourceSpec;
  /** Factory-backed providers: name of the Tools factory to instantiate. */
  factoryName?: string;
  /** For `"provider"`: per-instance config passed to the `Tools` create(). */
  config: Record<string, unknown>;
  /** For `"provider"`: handle the user wrote (when via `[providers]`). */
  providerHandle?: string;
  /** Provenance for diagnostics. */
  origin: ProviderOrigin;
}

/** One bound tool: model-facing name → provider instance + per-tool config. */
export interface ToolBinding {
  toolName: string;
  providerInstanceId: string;
  /**
   * Per-tool config (everything in `[tools.X]` other than `provider`).
   * For anonymous-instance bindings, this same map *also* flows to the
   * provider as its instance config — the provider does the split
   * between provider-level and per-tool keys per its registered schema.
   * Sharing follows from `(source, config)` dedup.
   */
  toolConfig: Record<string, unknown>;
  /** Source line for diagnostics (`"[tools.bash]"`). */
  origin: string;
}

/** Resolved harness selection. Singleton per agent. */
export interface HarnessBinding {
  /** Bare-handle factory name when builtin or `[providers]`-handled. */
  factoryName: string;
  /** SourceSpec to load (if a provider-backed harness); undefined for builtin. */
  source?: SourceSpec;
  /** Optional `[providers]` handle (when the user wrote one). */
  providerHandle?: string;
  /** Factory config (everything in `[harness]` other than `provider`). */
  config: Record<string, unknown>;
}

export interface SessionBinding {
  factoryName: string;
  source?: SourceSpec;
  providerHandle?: string;
  config: Record<string, unknown>;
}

/**
 * A pre-built `Session` instance slotted into a chain position. The
 * resolver records it verbatim; the runtime threads it through
 * instantiation without consulting any factory.
 */
export interface PreBuiltSessionLayer {
  preBuilt: true;
  instance: Session;
}

/**
 * One resolved entry in a layered session. Either a factory binding
 * to be instantiated, or a pre-built `Session` instance to be used
 * as-is. Discriminate with `"preBuilt" in layer`.
 */
export type ResolvedSessionLayer = SessionBinding | PreBuiltSessionLayer;

export function isPreBuiltSessionLayer(
  layer: ResolvedSessionLayer,
): layer is PreBuiltSessionLayer {
  return "preBuilt" in layer;
}

export interface ResolvedManifest {
  /** All distinct provider instances to materialise. */
  providers: ProviderInstance[];
  /** Bound tools. Order matches the manifest's `[tools]` insertion order. */
  tools: ToolBinding[];
  /**
   * Resolved harness factory binding. Undefined when `manifest.harness`
   * is a pre-built `Harness` instance (the runtime uses it directly).
   */
  harness?: HarnessBinding;
  /**
   * Resolved session chain. Each entry is a link in the composition
   * pipeline (outer-to-inner order); a length-1 array is the trivial
   * singleton case (matches a `[session]` table on disk). Entries may
   * be `SessionBinding`s (factory references the runtime instantiates)
   * or `PreBuiltSessionLayer`s (a Session instance passed through
   * untouched). Undefined when the manifest omits the session section
   * *or* when `manifest.session` is itself a single pre-built `Session`
   * instance (in which case the runtime uses it directly without ever
   * building a chain).
   */
  session?: ResolvedSessionLayer[];
  /**
   * All distinct SourceSpecs the manifest references, keyed by
   * {@link sourceSpecKey}. Used by `loom install` and audit.
   * Providers declared in `[providers]` map their local handle to
   * their spec; anonymous references appear under a synthetic key.
   */
  sources: Map<string, ResolvedSource>;
}

export interface ResolvedSource {
  /** Canonical key (see {@link sourceSpecKey}). */
  key: string;
  spec: SourceSpec;
  /** Local handle from `[providers]`, when declared; else undefined. */
  handle?: string;
  /** Where this source was found in the manifest (for diagnostics). */
  origins: string[];
}

// ─── The main resolution entry point ──────────────────────────────────────

export interface ResolveOptions {
  /**
   * Built-in tool names the native provider claims. Used to disambiguate
   * bare-handle tool `provider` values that match a builtin tool.
   * Defaults to the set known to the native provider at the call site.
   */
  builtinToolNames?: Set<string>;
}

/**
 * Resolve a parsed manifest into the runtime IR. Pure: no I/O.
 *
 * Throws `ResolutionError` for handle-collision / unresolved-handle
 * problems; throws `ManifestError` for shape errors that should
 * really have been caught at parse time but weren't.
 */
export function resolveManifest(
  manifest: AgentManifest,
  options: ResolveOptions = {},
): ResolvedManifest {
  const builtinToolNames = options.builtinToolNames ?? new Set<string>();
  const sources = new Map<string, ResolvedSource>();
  const providers: ProviderInstance[] = [];
  const tools: ToolBinding[] = [];

  // Index `[providers]` entries — local handle → (SourceSpec | factory).
  const providerIndex = resolveProvidersTable(manifest.providers, sources);

  // Cache for instance dedup. Key prefix discriminates source-backed
  // vs. factory-backed (built-in factory by name) instances; native
  // is a single slot with id "native".
  const instanceCache = new Map<string, string>(); // key → instance id
  let nextInstanceCounter = 1;

  /**
   * Bind one provider instance from one of three shapes:
   *   - `{ kind: "native" }`           → the singleton native provider
   *   - `{ kind: "source", source }`   → source-backed (loader instantiates)
   *   - `{ kind: "factory", factoryName }` → factory-backed (registry lookup)
   */
  function getOrCreateInstance(
    binding:
      | { kind: "native" }
      | { kind: "source"; source: SourceSpec }
      | { kind: "factory"; factoryName: string },
    config: Record<string, unknown>,
    origin: ProviderOrigin,
    providerHandle?: string,
  ): string {
    if (binding.kind === "native") {
      if (!instanceCache.has("native")) {
        instanceCache.set("native", "native");
        providers.push({
          id: "native",
          kind: "native",
          config: {},
          origin: { kind: "native" },
        });
      }
      return "native";
    }
    const cfgKey = configKey(config);
    const dedupKey =
      binding.kind === "source"
        ? `source|${sourceSpecKey(binding.source)}|${cfgKey}`
        : `factory|${binding.factoryName}|${cfgKey}`;
    const existing = instanceCache.get(dedupKey);
    if (existing) return existing;

    const id = `p${nextInstanceCounter++}`;
    instanceCache.set(dedupKey, id);
    if (binding.kind === "source") {
      providers.push({
        id,
        kind: "provider",
        source: binding.source,
        config,
        ...(providerHandle ? { providerHandle } : {}),
        origin,
      });
      addSource(sources, binding.source, originLabel(origin), providerHandle);
    } else {
      providers.push({
        id,
        kind: "provider",
        factoryName: binding.factoryName,
        config,
        ...(providerHandle ? { providerHandle } : {}),
        origin,
      });
      // Factory-backed instances aren't reflected in the `sources`
      // index — they have no SourceSpec. `loom install` / audit treat
      // them as built-in resolution targets.
    }
    return id;
  }

  // ─── Tools ──────────────────────────────────────────────────────────────────────
  const toolsTable = manifest.tools;
  if (toolsTable === undefined) {
    // Default builtin set — see AgentManifest.tools docs. The runtime
    // composes this; we just emit bindings to the native provider.
    for (const name of DEFAULT_BUILTIN_TOOLS) {
      const instanceId = getOrCreateInstance(
        { kind: "native" },
        {},
        { kind: "native" },
      );
      tools.push({
        toolName: name,
        providerInstanceId: instanceId,
        toolConfig: {},
        origin: "(default builtin)",
      });
    }
  } else {
    for (const [name, entry] of Object.entries(toolsTable)) {
      const binding = resolveToolEntry(
        name,
        entry,
        providerIndex,
        builtinToolNames,
        getOrCreateInstance,
      );
      tools.push(binding);
    }
  }

  // ─── Harness ───────────────────────────────────────────────────────────────
  // Pre-built `Harness` instances skip resolution — the runtime
  // uses them directly. Same goes for sessions.
  const harness =
    "provider" in manifest.harness
      ? resolveHarnessSpec(manifest.harness, providerIndex, sources)
      : undefined;

  // ─── Session ─────────────────────────────────────
  // ─── Session ─────────────────────────────────────
  // Four input shapes:
  //   * undefined → default chain applied later by the runtime
  //   * single pre-built `Session` instance → bypass resolution
  //     entirely (`session` stays undefined; runtime uses the
  //     instance directly)
  //   * `SessionSpec` (singleton) → length-1 binding array
  //   * `SessionLayerEntry[]` (chain) → one resolved layer per entry,
  //     in order. Entries may be strings (desugared to
  //     `{ provider: str }`), `SessionSpec`s (resolved normally), or
  //     pre-built `Session` instances (passed through as
  //     `PreBuiltSessionLayer`).
  let session: ResolvedSessionLayer[] | undefined;
  if (manifest.session !== undefined) {
    if (Array.isArray(manifest.session)) {
      session = manifest.session.map((entry, i) =>
        resolveSessionLayerEntry(entry, providerIndex, sources, i),
      );
    } else if (
      typeof manifest.session === "object" &&
      "provider" in manifest.session
    ) {
      session = [
        resolveSessionSpec(manifest.session, providerIndex, sources, undefined),
      ];
    }
    // else: single pre-built `Session` instance — leave `session`
    // undefined and let the runtime use the instance directly.
  }

  return {
    providers,
    tools,
    ...(harness ? { harness } : {}),
    ...(session ? { session } : {}),
    sources,
  };
}

// Tools auto-loaded when `[tools]` is absent. `find` is a built-in
// too, but opt-in only — list `find = "builtin"` in `[tools]` to
// pull it in. Same with `spawn_subagent`.
const DEFAULT_BUILTIN_TOOLS = ["bash", "read_file", "write_file", "edit_file"];

// ─── Internal: [providers] ─────────────────────────────────────────────────

/**
 * `[providers]` entries split into two parallel maps by shape:
 *
 *   - `sources`: handle → SourceSpec       (loader-backed)
 *   - `factories`: handle → factory ref     (configured-factory form)
 *
 * Downstream resolution (`resolveToolEntry`, `resolveFactoryReference`)
 * consults both: a bare handle in `[tools.X].provider` /
 * `[harness].provider` / `[session].provider` matches a `[providers]`
 * entry of either shape. The two maps share a handle namespace, so a
 * handle never appears in both at once.
 */
interface ProviderIndex {
  sources: Map<string, SourceSpec>;
  factories: Map<string, ConfiguredFactoryRef>;
}

/**
 * A configured-factory `[providers]` entry, normalised. The
 * `factoryName` is the bare-handle factory name (e.g. `"mcp-server"`);
 * source-loaded factories aren't supported in v1 (the parser accepts
 * any `Reference` but the resolver rejects non-handle forms here with
 * a clear error — see `resolveProvidersTable`).
 */
interface ConfiguredFactoryRef {
  factoryName: string;
  config: Record<string, unknown>;
}

function resolveProvidersTable(
  providersTable: Record<string, ProviderEntry> | undefined,
  sources: Map<string, ResolvedSource>,
): ProviderIndex {
  const out: ProviderIndex = {
    sources: new Map(),
    factories: new Map(),
  };
  if (!providersTable) return out;
  for (const [handle, entry] of Object.entries(providersTable)) {
    if (isProviderEntryTable(entry)) {
      // Configured-factory form: `{ provider = "<factory>", ...config }`.
      const { provider: factoryRef, ...config } = entry;
      const factoryName = referenceToHandle(factoryRef);
      if (!factoryName) {
        throw new ResolutionError(
          `[providers].${handle}.provider must be a bare factory name ` +
            `(e.g. "mcp-server"). Source-loaded factories aren't yet ` +
            `supported in the configured-factory form; got ` +
            `${JSON.stringify(factoryRef)}.`,
        );
      }
      // No collision with sources is possible — same map iteration.
      out.factories.set(handle, { factoryName, config });
      continue;
    }
    // SourceSpec form.
    const spec = referenceToSourceSpec(entry);
    if (!spec) {
      // Parser should have caught this — but defensive.
      throw new ManifestError(
        `[providers].${handle}: expected a SourceSpec or configured-factory ` +
          `table; got ${JSON.stringify(entry)}`,
      );
    }
    out.sources.set(handle, spec);
    addSource(sources, spec, `[providers].${handle}`, handle);
  }
  return out;
}

function isProviderEntryTable(e: ProviderEntry): e is ProviderEntryTable {
  return (
    typeof e === "object" && e !== null && !Array.isArray(e) && "provider" in e
  );
}

// ─── Internal: [tools.<name>] ─────────────────────────────────────────────

function resolveToolEntry(
  name: string,
  entry: ToolEntry,
  providerIndex: ProviderIndex,
  builtinToolNames: Set<string>,
  getOrCreateInstance: (
    binding:
      | { kind: "native" }
      | { kind: "source"; source: SourceSpec }
      | { kind: "factory"; factoryName: string },
    config: Record<string, unknown>,
    origin: ProviderOrigin,
    providerHandle?: string,
  ) => string,
): ToolBinding {
  // Normalise the on-disk shape to { provider, config }. The parser
  // rejects table entries that omit `provider`; this throw is
  // defensive for SDK-direct callers who bypass parser typing.
  let providerRef: Reference;
  let toolConfig: Record<string, unknown>;
  const originLabel = `[tools.${name}]`;
  if (typeof entry === "string") {
    providerRef = entry;
    toolConfig = {};
  } else {
    const { provider, ...rest } = entry as ToolEntryTable;
    if (provider === undefined) {
      throw new ManifestError(
        `${originLabel} is missing required 'provider' field. Use the string ` +
          `shorthand (e.g. "builtin") or table form with a 'provider' key.`,
      );
    }
    providerRef = provider;
    toolConfig = rest;
  }

  // Case 1: bare handle → [providers] (source or factory form), then
  // built-in registry.
  const handle = referenceToHandle(providerRef);
  if (handle) {
    if (handle === "builtin") {
      return {
        toolName: name,
        providerInstanceId: getOrCreateInstance(
          { kind: "native" },
          {},
          { kind: "native" },
        ),
        toolConfig,
        origin: originLabel,
      };
    }
    const providerSpec = providerIndex.sources.get(handle);
    const factoryRef = providerIndex.factories.get(handle);
    const isBuiltin = builtinToolNames.has(handle);
    // Collision detection: a handle that matches multiple resolution
    // targets is a fatal manifest error.
    const matches = [
      providerSpec || factoryRef ? `[providers].${handle}` : null,
      isBuiltin ? `built-in tool '${handle}'` : null,
    ].filter(Boolean) as string[];
    if (matches.length > 1) {
      throw new ResolutionError(
        `${originLabel}.provider = "${handle}": ambiguous — handle matches ${matches.join(" and ")}. ` +
          `Rename the conflicting entry or use the SourceSpec form to disambiguate.`,
      );
    }
    if (factoryRef) {
      // Configured-factory `[providers]` entry. There's a clean
      // separation here that we honour:
      //
      //   - The provider-level config (from `[providers].<handle>`)
      //     is what the factory's `create()` sees — i.e. how the
      //     provider connects / spawns. For MCP that's `command` /
      //     `args` / `npm` / `env` / `secrets`.
      //   - The per-tool config (from `[tools.X]` minus `provider`)
      //     flows to `resolveTool(name, config, …)` only. For MCP
      //     that's `mcp_tool` (rename target) and other routing
      //     concerns the FACTORY's resolveTool reads.
      //
      // Dedup uses only the provider-level config, so multiple
      // `[tools.X]` entries through the same `[providers]` handle
      // ALWAYS share one instance regardless of their per-tool
      // shapes — they're literally the same `server.resolveTool(...)`
      // call dispatched against the same Tools instance.
      return {
        toolName: name,
        providerInstanceId: getOrCreateInstance(
          { kind: "factory", factoryName: factoryRef.factoryName },
          factoryRef.config,
          {
            kind: "handle-factory",
            providerHandle: handle,
            factoryName: factoryRef.factoryName,
          },
          handle,
        ),
        toolConfig,
        origin: originLabel,
      };
    }
    if (providerSpec) {
      // Handle-anonymous: the tool's config flows to the Tools instance
      // as its per-instance config. Dedup by (source, config) shares
      // instances across multiple tools pointing at the same handle.
      return {
        toolName: name,
        providerInstanceId: getOrCreateInstance(
          { kind: "source", source: providerSpec },
          toolConfig,
          { kind: "handle-anonymous", providerHandle: handle },
          handle,
        ),
        toolConfig,
        origin: originLabel,
      };
    }
    if (isBuiltin) {
      // Bare-name builtin tool with `provider = "<builtin-name>"` —
      // unusual but legal. The native provider keys by tool name, so
      // this only works when name === handle.
      if (name !== handle) {
        throw new ResolutionError(
          `${originLabel}.provider = "${handle}": built-in tool names ` +
            `can only appear as a 'provider' value when the tool key ` +
            `matches the built-in name. Either rename the tool key, ` +
            `or use a [providers] entry / inline SourceSpec.`,
        );
      }
      return {
        toolName: name,
        providerInstanceId: getOrCreateInstance(
          { kind: "native" },
          {},
          { kind: "native" },
        ),
        toolConfig,
        origin: originLabel,
      };
    }
    throw new ResolutionError(
      `${originLabel}.provider = "${handle}": no matching [providers] entry ` +
        `or built-in. Declared providers: ${listOrNone([
          ...providerIndex.sources.keys(),
          ...providerIndex.factories.keys(),
        ])}.`,
    );
  }

  // Case 2: inline SourceSpec → anonymous instance, tool config flows
  // to the Tools instance.
  const spec = referenceToSourceSpec(providerRef);
  if (!spec) {
    throw new ManifestError(
      `${originLabel}.provider: unable to classify as handle or SourceSpec`,
    );
  }
  return {
    toolName: name,
    providerInstanceId: getOrCreateInstance(
      { kind: "source", source: spec },
      toolConfig,
      {
        kind: "inline-anonymous",
        toolName: name,
      },
    ),
    toolConfig,
    origin: originLabel,
  };
}

// ─── Internal: [harness] / [session] ──────────────────────────────────────

function resolveHarnessSpec(
  spec: AgentManifest["harness"],
  providerIndex: ProviderIndex,
  sources: Map<string, ResolvedSource>,
): HarnessBinding {
  // The runtime accepts a pre-built `Harness` instance too; in that
  // case we shouldn't be in resolveHarnessSpec at all — the runtime
  // handles it directly. The presence of `provider` disambiguates.
  if (!("provider" in spec)) {
    throw new ManifestError(
      `[harness]: a pre-built Harness instance was passed to resolveManifest; ` +
        `this path is only for HarnessSpec values (with a 'provider' field).`,
    );
  }
  const { provider, ...config } = spec as HarnessSpec;
  return resolveFactoryReference(
    provider,
    config,
    providerIndex,
    sources,
    "[harness]",
  );
}

/**
 * Resolve one entry in a layered-session array into a
 * `ResolvedSessionLayer`. Mirrors what the TOML parser does for
 * `[session].layers` entries (strings desugar to `{ provider: str }`,
 * inline tables pass through), and adds the pre-built-instance case
 * that has no TOML equivalent: any value that's an object without a
 * `provider` key is treated as a `Session` instance and recorded as
 * a `PreBuiltSessionLayer`.
 */
function resolveSessionLayerEntry(
  entry: SessionLayerEntry,
  providerIndex: ProviderIndex,
  sources: Map<string, ResolvedSource>,
  chainIndex: number,
): ResolvedSessionLayer {
  if (typeof entry === "string") {
    return resolveSessionSpec(
      { provider: entry },
      providerIndex,
      sources,
      chainIndex,
    );
  }
  if (entry && typeof entry === "object" && "provider" in entry) {
    return resolveSessionSpec(
      entry as SessionSpec,
      providerIndex,
      sources,
      chainIndex,
    );
  }
  if (entry && typeof entry === "object") {
    // Anything else with no `provider` field — treat it as a
    // pre-built `Session` instance. We don't structurally check
    // here; if it doesn't actually implement Session, the runtime
    // will surface that at the first push/pull call.
    return { preBuilt: true, instance: entry as Session };
  }
  throw new ManifestError(
    `[session].layers (entry ${chainIndex}): expected a string, an inline ` +
      `table with a 'provider' field, or a pre-built Session instance; ` +
      `got ${typeof entry}.`,
  );
}

function resolveSessionSpec(
  spec: SessionSpec,
  providerIndex: ProviderIndex,
  sources: Map<string, ResolvedSource>,
  chainIndex: number | undefined,
): SessionBinding {
  if (!spec || !("provider" in spec)) {
    throw new ManifestError(
      `[session]: a pre-built Session instance was passed to resolveManifest; ` +
        `this path is only for SessionSpec values (with a 'provider' field).`,
    );
  }
  const { provider, ...config } = spec;
  const label =
    chainIndex === undefined
      ? "[session]"
      : `[session].layers (entry ${chainIndex})`;
  return resolveFactoryReference(
    provider,
    config,
    providerIndex,
    sources,
    label,
  );
}

function resolveFactoryReference(
  ref: Reference,
  config: Record<string, unknown>,
  providerIndex: ProviderIndex,
  sources: Map<string, ResolvedSource>,
  label: string,
): {
  factoryName: string;
  source?: SourceSpec;
  providerHandle?: string;
  config: Record<string, unknown>;
} {
  const handle = referenceToHandle(ref);
  if (handle) {
    // Bare handle: either a [providers] entry (source or configured-
    // factory form), or a built-in registry name (factory by literal
    // name). Built-in registry membership is checked by the runtime;
    // we just normalise the binding here.
    const factoryRef = providerIndex.factories.get(handle);
    if (factoryRef) {
      // Configured-factory entry: the handle aliases another factory.
      // Provider-level config merges with call-site config; call-site
      // wins on collision (same precedence as the tool path).
      return {
        factoryName: factoryRef.factoryName,
        providerHandle: handle,
        config: { ...factoryRef.config, ...config },
      };
    }
    const spec = providerIndex.sources.get(handle);
    if (spec) {
      addSource(sources, spec, label, handle);
      return {
        factoryName: handle,
        source: spec,
        providerHandle: handle,
        config,
      };
    }
    return { factoryName: handle, config };
  }
  // Inline SourceSpec — anonymous. The factory name defaults to the
  // package name; the runtime knows the convention.
  const spec = referenceToSourceSpec(ref);
  if (!spec) {
    throw new ManifestError(
      `${label}.provider: unable to classify as handle or SourceSpec`,
    );
  }
  addSource(sources, spec, label);
  return {
    factoryName: defaultFactoryNameForSource(spec),
    source: spec,
    config,
  };
}

function defaultFactoryNameForSource(s: SourceSpec): string {
  if ("npm" in s) return s.npm;
  if ("path" in s) return path.basename(s.path);
  return "unknown";
}

// ─── SourceSpec index helpers ─────────────────────────────────────────────

function addSource(
  sources: Map<string, ResolvedSource>,
  spec: SourceSpec,
  origin: string,
  handle?: string,
): void {
  const key = sourceSpecKey(spec);
  const existing = sources.get(key);
  if (existing) {
    if (!existing.origins.includes(origin)) existing.origins.push(origin);
    if (handle && !existing.handle) existing.handle = handle;
    return;
  }
  sources.set(key, {
    key,
    spec,
    ...(handle ? { handle } : {}),
    origins: [origin],
  });
}

function originLabel(origin: ProviderOrigin): string {
  switch (origin.kind) {
    case "native":
      return "(native provider)";
    case "handle-anonymous":
      return `(via [providers].${origin.providerHandle})`;
    case "handle-factory":
      return `(via [providers].${origin.providerHandle} → factory '${origin.factoryName}')`;
    case "inline-anonymous":
      return origin.toolName
        ? `(inline at [tools.${origin.toolName}])`
        : "(inline)";
  }
}

function listOrNone(items: string[]): string {
  return items.length ? items.map((s) => `'${s}'`).join(", ") : "(none)";
}
