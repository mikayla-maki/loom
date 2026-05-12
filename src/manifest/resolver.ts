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
import type {
  AgentManifest,
  HarnessSpec,
  ProviderEntry,
  Reference,
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
  | { kind: "handle-anonymous"; providerHandle: string } // resolved via [providers].<handle>
  | { kind: "inline-anonymous"; toolName?: string }; // resolved via inline SourceSpec

/**
 * A `Tools` instance the runtime will materialise. The `id` is
 * stable across references that dedupe to the same instance.
 */
export interface ProviderInstance {
  /** Stable id used in tool bindings. `"native"` for the built-in. */
  id: string;
  /** `"native"` (the singleton) or `"provider"` (instantiated per-entry). */
  kind: "native" | "provider";
  /** For `"provider"`: SourceSpec the provider loads from. */
  source?: SourceSpec;
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
   * singleton case (matches a `[session]` table on disk). Undefined
   * when the manifest omits the session section *or* when
   * `manifest.session` is a pre-built `Session` instance.
   */
  session?: SessionBinding[];
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

  // Index `[providers]` entries — local handle → SourceSpec.
  const providerSources = resolveProvidersTable(manifest.providers, sources);

  // Cache for instance dedup. Key: `${sourceKey}|${configKey}` (native is
  // a single slot with id "native").
  const instanceCache = new Map<string, string>(); // key → instance id
  let nextInstanceCounter = 1;

  function getOrCreateInstance(
    source: SourceSpec | null,
    config: Record<string, unknown>,
    origin: ProviderOrigin,
    providerHandle?: string,
  ): string {
    if (source === null) {
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
    const srcKey = sourceSpecKey(source);
    const cfgKey = configKey(config);
    const dedupKey = `${srcKey}|${cfgKey}`;
    const existing = instanceCache.get(dedupKey);
    if (existing) return existing;

    const id = `p${nextInstanceCounter++}`;
    instanceCache.set(dedupKey, id);
    providers.push({
      id,
      kind: "provider",
      source,
      config,
      ...(providerHandle ? { providerHandle } : {}),
      origin,
    });
    // Track in sources index.
    addSource(sources, source, originLabel(origin), providerHandle);
    return id;
  }

  // ─── Tools ────────────────────────────────────────────────────────────
  const toolsTable = manifest.tools;
  if (toolsTable === undefined) {
    // Default builtin set — see AgentManifest.tools docs. The runtime
    // composes this; we just emit bindings to the native provider.
    for (const name of DEFAULT_BUILTIN_TOOLS) {
      const instanceId = getOrCreateInstance(null, {}, { kind: "native" });
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
        providerSources,
        builtinToolNames,
        getOrCreateInstance,
      );
      tools.push(binding);
    }
  }

  // ─── Harness ──────────────────────────────────────────────────────────
  // Pre-built `Harness` instances skip resolution — the runtime
  // uses them directly. Same goes for sessions.
  const harness =
    "provider" in manifest.harness
      ? resolveHarnessSpec(manifest.harness, providerSources, sources)
      : undefined;

  // ─── Session ────────────────────────────────────────────
  // Three input shapes:
  //   * undefined → default chain applied later by the runtime
  //   * pre-built `Session` instance → bypass resolution
  //   * `SessionSpec` (singleton) → length-1 binding array
  //   * `SessionSpec[]` (chain) → one binding per entry, in order
  let session: SessionBinding[] | undefined;
  if (manifest.session !== undefined) {
    if (Array.isArray(manifest.session)) {
      session = manifest.session.map((spec, i) =>
        resolveSessionSpec(spec, providerSources, sources, i),
      );
    } else if ("provider" in manifest.session) {
      session = [
        resolveSessionSpec(
          manifest.session,
          providerSources,
          sources,
          undefined,
        ),
      ];
    }
    // else: pre-built `Session` instance — leave `session` undefined
    // and let the runtime use the instance directly.
  }

  return {
    providers,
    tools,
    ...(harness ? { harness } : {}),
    ...(session ? { session } : {}),
    sources,
  };
}

const DEFAULT_BUILTIN_TOOLS = ["bash", "read_file", "write_file", "find"];

// ─── Internal: [providers] ────────────────────────────────────────────────

function resolveProvidersTable(
  providersTable: Record<string, ProviderEntry> | undefined,
  sources: Map<string, ResolvedSource>,
): Map<string, SourceSpec> {
  const out = new Map<string, SourceSpec>();
  if (!providersTable) return out;
  for (const [handle, entry] of Object.entries(providersTable)) {
    const spec = referenceToSourceSpec(entry);
    if (!spec) {
      // Parser should have caught this — but defensive.
      throw new ManifestError(
        `[providers].${handle}: expected a SourceSpec; got ${JSON.stringify(entry)}`,
      );
    }
    out.set(handle, spec);
    addSource(sources, spec, `[providers].${handle}`, handle);
  }
  return out;
}

// ─── Internal: [tools.<name>] ─────────────────────────────────────────────

function resolveToolEntry(
  name: string,
  entry: ToolEntry,
  providerSources: Map<string, SourceSpec>,
  builtinToolNames: Set<string>,
  getOrCreateInstance: (
    source: SourceSpec | null,
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

  // Case 1: bare handle → [providers] first, then built-in registry.
  const handle = referenceToHandle(providerRef);
  if (handle) {
    if (handle === "builtin") {
      return {
        toolName: name,
        providerInstanceId: getOrCreateInstance(null, {}, { kind: "native" }),
        toolConfig,
        origin: originLabel,
      };
    }
    const providerSpec = providerSources.get(handle);
    const isBuiltin = builtinToolNames.has(handle);
    // Collision detection: a handle that matches both a builtin and a
    // [providers] entry is a parse error.
    const matches = [
      providerSpec ? `[providers].${handle}` : null,
      isBuiltin ? `built-in tool '${handle}'` : null,
    ].filter(Boolean) as string[];
    if (matches.length > 1) {
      throw new ResolutionError(
        `${originLabel}.provider = "${handle}": ambiguous — handle matches ${matches.join(" and ")}. ` +
          `Rename the conflicting entry or use the SourceSpec form to disambiguate.`,
      );
    }
    if (providerSpec) {
      // Handle-anonymous: the tool's config flows to the Tools instance
      // as its per-instance config. Dedup by (source, config) shares
      // instances across multiple tools pointing at the same handle.
      return {
        toolName: name,
        providerInstanceId: getOrCreateInstance(
          providerSpec,
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
        providerInstanceId: getOrCreateInstance(null, {}, { kind: "native" }),
        toolConfig,
        origin: originLabel,
      };
    }
    throw new ResolutionError(
      `${originLabel}.provider = "${handle}": no matching [providers] entry ` +
        `or built-in. Declared providers: ${listOrNone([...providerSources.keys()])}.`,
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
    providerInstanceId: getOrCreateInstance(spec, toolConfig, {
      kind: "inline-anonymous",
      toolName: name,
    }),
    toolConfig,
    origin: originLabel,
  };
}

// ─── Internal: [harness] / [session] ──────────────────────────────────────

function resolveHarnessSpec(
  spec: AgentManifest["harness"],
  providerSources: Map<string, SourceSpec>,
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
    providerSources,
    sources,
    "[harness]",
  );
}

function resolveSessionSpec(
  spec: SessionSpec,
  providerSources: Map<string, SourceSpec>,
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
    providerSources,
    sources,
    label,
  );
}

function resolveFactoryReference(
  ref: Reference,
  config: Record<string, unknown>,
  providerSources: Map<string, SourceSpec>,
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
    // Bare handle: either a [providers] entry (use that provider's
    // factory) or a built-in registry name (factory by literal name).
    // We can't check built-in registry membership here without the
    // runtime — defer that check to the runtime, which throws a
    // pointed error if missing.
    const spec = providerSources.get(handle);
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
    case "inline-anonymous":
      return origin.toolName
        ? `(inline at [tools.${origin.toolName}])`
        : "(inline)";
  }
}

function listOrNone(items: string[]): string {
  return items.length ? items.map((s) => `'${s}'`).join(", ") : "(none)";
}
