import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ManifestError, ResolutionError } from "../errors.js";
import { expandHome } from "../internal/util.js";
import type { Session } from "../types/interfaces.js";
import type {
  AgentManifest,
  CapabilitySet,
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

export function isBareHandle(s: string): boolean {
  return (
    !s.startsWith("./") &&
    !s.startsWith("../") &&
    !s.startsWith("/") &&
    !s.includes("/")
  );
}

export function referenceToSourceSpec(ref: Reference): SourceSpec | null {
  if (typeof ref === "string") {
    if (
      ref.startsWith("./") ||
      ref.startsWith("../") ||
      ref.startsWith("~/") ||
      ref === "~" ||
      ref.startsWith("/")
    ) {
      return { path: ref };
    }
    if (ref.includes("/")) {
      return { npm: ref };
    }
    return null;
  }
  return ref;
}

export function referenceToHandle(ref: Reference): string | null {
  if (typeof ref === "string" && isBareHandle(ref)) return ref;
  return null;
}

export function sourceSpecKey(s: SourceSpec): string {
  if ("npm" in s) return `npm:${s.npm}@${s.version ?? "*"}`;
  if ("path" in s) return `path:${s.path}${s.subpath ? "#" + s.subpath : ""}`;
  return `unknown:${JSON.stringify(s)}`;
}

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

export type ProviderOrigin =
  | { kind: "native" }
  | { kind: "handle-anonymous"; providerHandle: string }
  | {
      kind: "handle-factory";
      providerHandle: string;
      factoryName: string;
    }
  | { kind: "inline-anonymous"; toolName?: string };

export interface ProviderInstance {
  id: string;
  kind: "native" | "provider";
  source?: SourceSpec;
  factoryName?: string;
  config: Record<string, unknown>;
  providerHandle?: string;
  origin: ProviderOrigin;
}

export interface ToolBinding {
  toolName: string;
  /** The name the implementation dispatches on; equals `toolName` unless renamed via `tool =`. */
  underlyingName: string;
  providerInstanceId: string;
  /** Reserved keys only (currently just `tool`); arbitrary per-tool config no longer exists. */
  toolConfig: Record<string, unknown>;
  /** The entry's requested grant; undefined = request the full ceiling entry. */
  requestedGrant?: CapabilitySet;
  origin: string;
}

export interface HarnessBinding {
  factoryName: string;
  source?: SourceSpec;
  providerHandle?: string;
  config: Record<string, unknown>;
}

export interface SessionBinding {
  factoryName: string;
  source?: SourceSpec;
  providerHandle?: string;
  config: Record<string, unknown>;
}

export interface PreBuiltSessionLayer {
  preBuilt: true;
  instance: Session;
}

export type ResolvedSessionLayer = SessionBinding | PreBuiltSessionLayer;

export function isPreBuiltSessionLayer(
  layer: ResolvedSessionLayer,
): layer is PreBuiltSessionLayer {
  return "preBuilt" in layer;
}

export interface ResolvedManifest {
  providers: ProviderInstance[];
  tools: ToolBinding[];
  harness?: HarnessBinding;
  session?: ResolvedSessionLayer[];
  sources: Map<string, ResolvedSource>;
}

export interface ResolvedSource {
  key: string;
  spec: SourceSpec;
  handle?: string;
  origins: string[];
}

export interface ResolveOptions {
  builtinToolNames?: Set<string>;
  harnessFactoryName?: string;
  // Per-tool-instance override for a source's origin label, keyed by instance
  // name. Lets a source a contributed tool group brought in be attributed to
  // that group (e.g. "skill 'echo-notes'") instead of the synthetic
  // `[tools.X]` entry the augmented manifest folds it into.
  toolOrigins?: Record<string, string>;
}

export function resolveManifest(
  manifest: AgentManifest,
  options: ResolveOptions = {},
): ResolvedManifest {
  const builtinToolNames = options.builtinToolNames ?? new Set<string>();
  const harnessFactoryName =
    options.harnessFactoryName ??
    ("provider" in manifest.harness
      ? deriveHarnessFactoryName(manifest.harness)
      : undefined);
  const sources = new Map<string, ResolvedSource>();
  const providers: ProviderInstance[] = [];
  const tools: ToolBinding[] = [];

  const providerIndex = resolveProvidersTable(manifest.providers, sources);

  const instanceCache = new Map<string, string>();
  let nextInstanceCounter = 1;

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
      addSource(
        sources,
        binding.source,
        sourceOriginLabel(origin, options.toolOrigins),
        providerHandle,
      );
    } else {
      providers.push({
        id,
        kind: "provider",
        factoryName: binding.factoryName,
        config,
        ...(providerHandle ? { providerHandle } : {}),
        origin,
      });
    }
    return id;
  }

  const toolsTable = manifest.tools;
  if (toolsTable === undefined) {
    for (const name of DEFAULT_BUILTIN_TOOLS) {
      const instanceId = getOrCreateInstance(
        { kind: "native" },
        {},
        { kind: "native" },
      );
      tools.push({
        toolName: name,
        underlyingName: name,
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
        harnessFactoryName,
        getOrCreateInstance,
      );
      tools.push(binding);
    }
  }

  const harness =
    "provider" in manifest.harness
      ? resolveHarnessSpec(manifest.harness, providerIndex, sources)
      : undefined;

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
  }

  return {
    providers,
    tools,
    ...(harness ? { harness } : {}),
    ...(session ? { session } : {}),
    sources,
  };
}

export const DEFAULT_BUILTIN_TOOLS = [
  "bash",
  "read_file",
  "write_file",
  "edit_file",
];

interface ProviderIndex {
  sources: Map<string, SourceSpec>;
  factories: Map<string, ConfiguredFactoryRef>;
}

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
      out.factories.set(
        handle,
        resolveConfiguredFactory(entry, `[providers].${handle}`),
      );
      continue;
    }
    const spec = referenceToSourceSpec(entry);
    if (!spec) {
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

function isProviderEntryTable(e: unknown): e is ProviderEntryTable {
  return (
    typeof e === "object" && e !== null && !Array.isArray(e) && "provider" in e
  );
}

// Single resolution path for configured provider entries wherever they appear.
function resolveConfiguredFactory(
  entry: ProviderEntryTable,
  label: string,
): ConfiguredFactoryRef {
  const { provider: factoryRef, ...config } = entry;
  const factoryName = referenceToHandle(factoryRef);
  if (!factoryName) {
    throw new ResolutionError(
      `${label}.provider must be a bare factory name ` +
        `(e.g. "mcp-server"). Source-loaded factories aren't yet ` +
        `supported in the configured-factory form; got ` +
        `${JSON.stringify(factoryRef)}.`,
    );
  }
  return { factoryName, config };
}

function resolveToolEntry(
  name: string,
  entry: ToolEntry,
  providerIndex: ProviderIndex,
  builtinToolNames: Set<string>,
  harnessFactoryName: string | undefined,
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
  let providerRef: Reference | ProviderEntryTable;
  let underlyingName = name;
  let requestedGrant: CapabilitySet | undefined;
  const originLabel = `[tools.${name}]`;
  if (typeof entry === "string") {
    providerRef = entry;
  } else {
    const table = entry as ToolEntryTable;
    if (table.provider === undefined) {
      throw new ManifestError(
        `${originLabel} is missing required 'provider' field. Use the string ` +
          `shorthand (e.g. "builtin") or table form with a 'provider' key.`,
      );
    }
    providerRef = table.provider;
    if (table.tool !== undefined) underlyingName = table.tool;
    if (table.capabilities !== undefined) requestedGrant = table.capabilities;
  }
  const toolConfig: Record<string, unknown> =
    underlyingName === name ? {} : { tool: underlyingName };
  const common = {
    toolName: name,
    underlyingName,
    toolConfig,
    ...(requestedGrant !== undefined ? { requestedGrant } : {}),
    origin: originLabel,
  };

  // Instances dedup by (factory, config) value, so an inline table equal in
  // value to a [providers] entry collapses to the same instance.
  if (isProviderEntryTable(providerRef)) {
    const { factoryName, config } = resolveConfiguredFactory(
      providerRef,
      originLabel,
    );
    return {
      ...common,
      providerInstanceId: getOrCreateInstance(
        { kind: "factory", factoryName },
        config,
        { kind: "inline-anonymous", toolName: name },
      ),
    };
  }

  const handle = referenceToHandle(providerRef);
  if (handle) {
    if (handle === "builtin") {
      return {
        ...common,
        providerInstanceId: getOrCreateInstance(
          { kind: "native" },
          {},
          { kind: "native" },
        ),
      };
    }
    // Reserved like "builtin": implemented by the session chain's resolveTool.
    if (handle === "session") {
      return {
        ...common,
        providerInstanceId: "(session)",
      };
    }
    const providerSpec = providerIndex.sources.get(handle);
    const factoryRef = providerIndex.factories.get(handle);
    const isBuiltin = builtinToolNames.has(handle);
    const isHarnessName =
      harnessFactoryName !== undefined && handle === harnessFactoryName;
    const matches = [
      providerSpec || factoryRef ? `[providers].${handle}` : null,
      isBuiltin ? `built-in tool '${handle}'` : null,
      isHarnessName ? `harness '${handle}'` : null,
    ].filter(Boolean) as string[];
    if (matches.length > 1) {
      throw new ResolutionError(
        `${originLabel}.provider = "${handle}": ambiguous — handle matches ${matches.join(" and ")}. ` +
          `Rename the conflicting entry or use the SourceSpec form to disambiguate.`,
      );
    }
    if (factoryRef) {
      return {
        ...common,
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
      };
    }
    if (providerSpec) {
      return {
        ...common,
        providerInstanceId: getOrCreateInstance(
          { kind: "source", source: providerSpec },
          {},
          { kind: "handle-anonymous", providerHandle: handle },
          handle,
        ),
      };
    }
    if (isBuiltin) {
      // `provider = "bash"` as a bare builtin name: the underlying builtin is
      // the handle itself, so a differing key is a rename (`tool =` implied).
      if (name !== handle && underlyingName !== handle) {
        return {
          ...common,
          underlyingName: handle,
          toolConfig: { tool: handle },
          providerInstanceId: getOrCreateInstance(
            { kind: "native" },
            {},
            { kind: "native" },
          ),
        };
      }
      return {
        ...common,
        underlyingName: handle,
        toolConfig: name === handle ? {} : { tool: handle },
        providerInstanceId: getOrCreateInstance(
          { kind: "native" },
          {},
          { kind: "native" },
        ),
      };
    }
    if (isHarnessName) {
      return {
        ...common,
        providerInstanceId: "(harness)",
      };
    }
    throw new ResolutionError(
      `${originLabel}.provider = "${handle}": no matching [providers] entry ` +
        `or built-in${harnessFactoryName ? `, and doesn't match the harness factory name '${harnessFactoryName}'` : ""}. ` +
        `Declared providers: ${listOrNone([
          ...providerIndex.sources.keys(),
          ...providerIndex.factories.keys(),
        ])}.`,
    );
  }

  const spec = referenceToSourceSpec(providerRef);
  if (!spec) {
    throw new ManifestError(
      `${originLabel}.provider: unable to classify as handle or SourceSpec`,
    );
  }
  return {
    ...common,
    providerInstanceId: getOrCreateInstance(
      { kind: "source", source: spec },
      {},
      {
        kind: "inline-anonymous",
        toolName: name,
      },
    ),
  };
}

function resolveHarnessSpec(
  spec: AgentManifest["harness"],
  providerIndex: ProviderIndex,
  sources: Map<string, ResolvedSource>,
): HarnessBinding {
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
    const factoryRef = providerIndex.factories.get(handle);
    if (factoryRef) {
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

function deriveHarnessFactoryName(
  spec: AgentManifest["harness"],
): string | undefined {
  if (!("provider" in spec)) return undefined;
  const ref = (spec as HarnessSpec).provider;
  const handle = referenceToHandle(ref);
  if (handle) return handle;
  const src = referenceToSourceSpec(ref);
  if (!src) return undefined;
  return defaultFactoryNameForSource(src);
}

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

function sourceOriginLabel(
  origin: ProviderOrigin,
  overrides: Record<string, string> | undefined,
): string {
  if (
    origin.kind === "inline-anonymous" &&
    origin.toolName &&
    overrides?.[origin.toolName]
  ) {
    return overrides[origin.toolName] as string;
  }
  return originLabel(origin);
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
