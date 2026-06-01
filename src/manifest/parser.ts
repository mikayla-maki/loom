import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as TOML from "toml";

import { ManifestError } from "../errors.js";
import { substituteEnv } from "./env-substitution.js";
import type {
  AgentManifest,
  Capabilities,
  CapabilitySet,
  CapabilityValue,
  HarnessSpec,
  ProviderEntry,
  Providers,
  Reference,
  SecretAllowlist,
  SessionSpec,
  SourceSpec,
  SystemPromptSpec,
  ToolEntry,
} from "../types/manifest.js";

export async function parseAgentManifest(
  manifestPath: string,
): Promise<AgentManifest> {
  const abs = path.resolve(manifestPath);
  const rawToml = await readToml(abs, "agent.toml");
  const raw = substituteEnv(rawToml, { context: abs }) as Record<
    string,
    unknown
  >;

  const agent = ensureObject(raw.agent, "[agent]", abs);
  if (typeof agent.name !== "string" || !agent.name) {
    throw new ManifestError(
      `agent.toml at ${abs} is missing required [agent].name`,
    );
  }
  const systemPrompt = parseSystemPromptSpec(agent.system_prompt, abs);
  const secrets = parseSecretAllowlist(agent.secrets, abs);
  const storageId = parseStorageId(agent.storage_id, abs);
  const metadata = parseMetadata(agent.metadata, abs);

  const providers =
    raw.providers === undefined
      ? undefined
      : parseProviders(raw.providers, abs);

  const harness = parseHarnessSpec(
    ensureObject(raw.harness, "[harness]", abs),
    abs,
  );

  let session: SessionSpec | SessionSpec[] | undefined;
  if (raw.session !== undefined) {
    session = parseSessionField(raw.session, abs);
  }

  const tools =
    raw.tools === undefined ? undefined : parseToolTable(raw.tools, abs);

  const capabilities =
    raw.capabilities === undefined
      ? undefined
      : parseCapabilities(raw.capabilities, abs);

  return {
    manifestPath: abs,
    name: agent.name,
    ...(typeof agent.description === "string"
      ? { description: agent.description }
      : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(secrets !== undefined ? { secrets } : {}),
    ...(storageId !== undefined ? { storageId } : {}),
    ...(providers ? { providers } : {}),
    harness,
    ...(session ? { session } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function parseMetadata(
  v: unknown,
  where: string,
): Record<string, unknown> | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ManifestError(
      `agent.toml at ${where}: [agent.metadata] must be a table (got ${
        Array.isArray(v) ? "array" : typeof v
      })`,
    );
  }
  return v as Record<string, unknown>;
}

function parseStorageId(v: unknown, where: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0) {
    throw new ManifestError(
      `agent.toml at ${where}: [agent].storage_id must be a non-empty string`,
    );
  }
  if (v.includes("/") || v.includes("\\")) {
    throw new ManifestError(
      `agent.toml at ${where}: [agent].storage_id '${v}' contains a ` +
        `path separator. Use letters, digits, underscore, dash, or dot.`,
    );
  }
  return v;
}

function parseSystemPromptSpec(
  v: unknown,
  where: string,
): SystemPromptSpec | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if (typeof obj.path === "string") return { path: obj.path };
  }
  throw new ManifestError(
    `agent.toml at ${where}: [agent].system_prompt must be a string or a table { path = "..." } (got ${typeof v})`,
  );
}

function parseSecretAllowlist(
  v: unknown,
  where: string,
): SecretAllowlist | undefined {
  if (v === undefined || v === null) return undefined;
  if (v === "*") return "*";
  if (Array.isArray(v)) {
    if (!v.every((x) => typeof x === "string")) {
      throw new ManifestError(
        `agent.toml at ${where}: [agent].secrets must be "*" or an array of strings`,
      );
    }
    return v as string[];
  }
  throw new ManifestError(
    `agent.toml at ${where}: [agent].secrets must be "*" or an array of strings, got ${typeof v}`,
  );
}

function parseProviders(v: unknown, where: string): Providers {
  const obj = ensureObject(v, "[providers]", where);
  const out: Providers = {};
  for (const [handle, val] of Object.entries(obj)) {
    validateHandle(handle, `[providers].${handle}`, where);
    out[handle] = parseProviderEntry(val, `[providers].${handle}`, where);
  }
  return out;
}

function parseProviderEntry(
  v: unknown,
  label: string,
  where: string,
): ProviderEntry {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if (obj.provider !== undefined) {
      const provider = parseReference(obj.provider, `${label}.provider`, where);
      const { provider: _p, ...config } = obj;
      void _p;
      return { provider, ...config };
    }
    return parseSourceSpecTable(obj, label, where);
  }
  const ref = parseReference(v, label, where);
  if (typeof ref === "string" && !isSourceSpecShapedString(ref)) {
    throw new ManifestError(
      `agent.toml at ${where}: ${label} must be a SourceSpec (npm-shaped string, ` +
        `"./path", or a table { npm = "..." } / { path = "..." }), or the ` +
        `configured-factory form { provider = "<factory>", ...config }. ` +
        `Bare handles aren't allowed at this layer — that would be a circular reference.`,
    );
  }
  return ref;
}

function parseToolTable(v: unknown, where: string): Record<string, ToolEntry> {
  const obj = ensureObject(v, "[tools]", where);
  const out: Record<string, ToolEntry> = {};
  for (const [k, val] of Object.entries(obj)) {
    out[k] = parseToolEntry(val, `[tools].${k}`, where);
  }
  return out;
}

function parseToolEntry(v: unknown, label: string, where: string): ToolEntry {
  if (typeof v === "string") {
    if (v.length === 0) {
      throw new ManifestError(
        `agent.toml at ${where}: ${label} must be a non-empty string`,
      );
    }
    validateReferenceString(v, label, where);
    return v;
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if (obj.provider === undefined) {
      throw new ManifestError(
        `agent.toml at ${where}: ${label} is missing required 'provider' field. ` +
          `Every [tools.X] entry must name a provider (e.g. ${label} = "builtin" ` +
          `for native tools, or ${label} = { provider = "<handle>", ...config } ` +
          `for a provider-backed tool). Empty \`{}\` is not accepted.`,
      );
    }
    const provider = parseReference(obj.provider, `${label}.provider`, where);
    const { provider: _p, ...config } = obj;
    void _p;
    return { provider, ...config };
  }
  throw new ManifestError(
    `agent.toml at ${where}: ${label} must be a string or a table, got ${typeof v}`,
  );
}

function parseHarnessSpec(
  raw: Record<string, unknown>,
  where: string,
): HarnessSpec {
  if (raw.provider === undefined) {
    throw new ManifestError(
      `agent.toml at ${where}: [harness] is missing required 'provider' field ` +
        `(a built-in harness name like "anthropic", a [providers] handle, ` +
        `or an inline SourceSpec)`,
    );
  }
  const provider = parseReference(raw.provider, "[harness].provider", where);
  const { provider: _p, ...config } = raw;
  void _p;
  return { provider, ...config };
}

function parseSessionField(
  v: unknown,
  where: string,
): SessionSpec | SessionSpec[] {
  if (Array.isArray(v)) {
    throw new ManifestError(
      `agent.toml at ${where}: top-level [[session]] (array-of-tables) is no longer accepted. ` +
        `Use [session] with a 'layers' array instead:\n\n` +
        `  [session]\n  layers = ["compacting", "memory"]\n\n` +
        `or the dotted-key array-of-tables form:\n\n` +
        `  [[session.layers]]\n  provider = "compacting"\n  threshold = 60`,
    );
  }
  const obj = ensureObject(v, "[session]", where);
  const hasProvider = obj.provider !== undefined;
  const hasLayers = obj.layers !== undefined;

  if (hasProvider && hasLayers) {
    throw new ManifestError(
      `agent.toml at ${where}: [session] has both 'provider' and 'layers'. ` +
        `Pick one: 'provider' for a singleton session, 'layers' for a chain.`,
    );
  }
  if (!hasProvider && !hasLayers) {
    throw new ManifestError(
      `agent.toml at ${where}: [session] is missing both 'provider' and 'layers'. ` +
        `A singleton needs 'provider = "<name>"'; a chain needs 'layers = [...]' ` +
        `(or [[session.layers]] entries). Omit the [session] block entirely to ` +
        `use the default chain.`,
    );
  }

  if (hasLayers) {
    const specs = parseSessionLayers(obj.layers, where);
    applySessionSiblingConfigs(specs, obj, where);
    return specs;
  }
  return parseSessionSpec(obj, where);
}

function applySessionSiblingConfigs(
  specs: SessionSpec[],
  parent: Record<string, unknown>,
  where: string,
): void {
  const rawLayers = parent.layers as unknown[];
  const stringIndicesByName = new Map<string, number[]>();
  const inlineTableNames = new Set<string>();
  for (let i = 0; i < rawLayers.length; i++) {
    const v = rawLayers[i];
    if (typeof v === "string") {
      const arr = stringIndicesByName.get(v) ?? [];
      arr.push(i);
      stringIndicesByName.set(v, arr);
    } else if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof (v as { provider?: unknown }).provider === "string"
    ) {
      inlineTableNames.add((v as { provider: string }).provider);
    }
  }

  for (const [key, value] of Object.entries(parent)) {
    if (key === "provider" || key === "layers") continue;

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ManifestError(
        `agent.toml at ${where}: [session].${key} is not a recognised meta key ` +
          `('provider'/'layers') and not a sub-table. Per-layer config siblings ` +
          `must be TOML tables — e.g.\n\n` +
          `  [session.${key}]\n  key = "value"\n\n` +
          `to provide config for a layer named '${key}' listed in [session].layers.`,
      );
    }

    const positions = stringIndicesByName.get(key);
    if (!positions) {
      if (inlineTableNames.has(key)) {
        throw new ManifestError(
          `agent.toml at ${where}: [session.${key}] conflicts with an inline-table ` +
            `entry for '${key}' in [session].layers. Pick one: keep the inline ` +
            `form, or convert the layers entry to the string shorthand ` +
            `("${key}") and move all of its config to [session.${key}].`,
        );
      }
      throw new ManifestError(
        `agent.toml at ${where}: [session.${key}] has no matching string entry ` +
          `in [session].layers. Add '${key}' to layers (e.g. layers = […, "${key}", …]) ` +
          `to apply this config, or remove the sibling table.`,
      );
    }

    const siblingConfig = value as Record<string, unknown>;
    if ("provider" in siblingConfig) {
      throw new ManifestError(
        `agent.toml at ${where}: [session.${key}].provider is not allowed. The ` +
          `layer's provider is determined by its entry in [session].layers (here: ` +
          `'${key}'); the sibling table only carries config.`,
      );
    }

    for (const i of positions) {
      const existing = specs[i];
      if (!existing) continue;
      specs[i] = {
        ...siblingConfig,
        ...existing,
        provider: existing.provider,
      };
    }
  }
}

function parseSessionLayers(v: unknown, where: string): SessionSpec[] {
  if (!Array.isArray(v)) {
    throw new ManifestError(
      `agent.toml at ${where}: [session].layers must be an array of layer ` +
        `entries (strings or inline tables). Got ${typeof v}.`,
    );
  }
  if (v.length === 0) {
    throw new ManifestError(
      `agent.toml at ${where}: [session].layers is empty. A layered session ` +
        `needs at least one entry; omit the [session] block to use the default chain.`,
    );
  }
  return v.map((entry, i) => parseLayerEntry(entry, i, where));
}

function parseLayerEntry(
  v: unknown,
  index: number,
  where: string,
): SessionSpec {
  if (typeof v === "string") {
    if (v.length === 0) {
      throw new ManifestError(
        `agent.toml at ${where}: [session].layers entry ${index} is an empty string`,
      );
    }
    validateReferenceString(v, `[session].layers (entry ${index})`, where);
    return { provider: v };
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return parseSessionSpec(
      v as Record<string, unknown>,
      where,
      `[session].layers (entry ${index})`,
    );
  }
  throw new ManifestError(
    `agent.toml at ${where}: [session].layers entry ${index} must be a string ` +
      `or an inline table with a 'provider' field; got ${typeof v}.`,
  );
}

function parseSessionSpec(
  raw: Record<string, unknown>,
  where: string,
  label = "[session]",
): SessionSpec {
  if (raw.provider === undefined) {
    throw new ManifestError(
      `agent.toml at ${where}: ${label} is missing required 'provider' field ` +
        `(a built-in session name like "memory", a [providers] handle, ` +
        `or an inline SourceSpec)`,
    );
  }
  const provider = parseReference(raw.provider, `${label}.provider`, where);
  const { provider: _p, ...config } = raw;
  void _p;
  return { provider, ...config };
}

function parseReference(v: unknown, label: string, where: string): Reference {
  if (typeof v === "string") {
    if (v.length === 0) {
      throw new ManifestError(
        `agent.toml at ${where}: ${label} must be a non-empty string`,
      );
    }
    validateReferenceString(v, label, where);
    return v;
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return parseSourceSpecTable(v as Record<string, unknown>, label, where);
  }
  throw new ManifestError(
    `agent.toml at ${where}: ${label} must be a string or a SourceSpec table, ` +
      `got ${typeof v}`,
  );
}

function validateReferenceString(
  s: string,
  label: string,
  where: string,
): void {
  if (s.startsWith("./") || s.startsWith("../")) return;
  if (s.startsWith("/")) {
    throw new ManifestError(
      `agent.toml at ${where}: ${label} "${s}" is an absolute path. ` +
        `Use the table form: ${label} = { path = "${s}" }.`,
    );
  }
  if (s.includes("/")) {
    if (!/^[@a-zA-Z0-9_\-./]+$/.test(s)) {
      throw new ManifestError(
        `agent.toml at ${where}: ${label} "${s}" doesn't look like a valid ` +
          `npm package reference`,
      );
    }
    return;
  }
  if (s.includes("@")) {
    throw new ManifestError(
      `agent.toml at ${where}: ${label} "${s}" contains '@' without a slash. ` +
        `Scoped npm packages must use the form "@scope/pkg".`,
    );
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_\-.]*$/.test(s)) {
    throw new ManifestError(
      `agent.toml at ${where}: ${label} "${s}" is not a valid handle ` +
        `(letters, digits, underscore, dash, dot; must start with letter or underscore)`,
    );
  }
}

function validateHandle(s: string, label: string, where: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_\-.]*$/.test(s)) {
    throw new ManifestError(
      `agent.toml at ${where}: ${label} is not a valid handle name ` +
        `(letters, digits, underscore, dash, dot; must start with letter or underscore)`,
    );
  }
}

function isSourceSpecShapedString(s: string): boolean {
  return s.startsWith("./") || s.startsWith("../") || s.includes("/");
}

function parseSourceSpecTable(
  obj: Record<string, unknown>,
  label: string,
  where: string,
): SourceSpec {
  const sourceKeys = ["npm", "path"] as const;
  const present = sourceKeys.filter((k) => obj[k] !== undefined);
  if (present.length === 0) {
    throw new ManifestError(
      `agent.toml at ${where}: ${label} must have exactly one of: ${sourceKeys.join(", ")}`,
    );
  }
  if (present.length > 1) {
    throw new ManifestError(
      `agent.toml at ${where}: ${label} has multiple source kinds (${present.join(", ")}); pick one`,
    );
  }
  const [kind] = present as [(typeof sourceKeys)[number]];
  if (kind === "npm") {
    if (typeof obj.npm !== "string" || !obj.npm) {
      throw new ManifestError(
        `agent.toml at ${where}: ${label}.npm must be a non-empty string (package name)`,
      );
    }
    const out: { npm: string; version?: string } = { npm: obj.npm };
    if (obj.version !== undefined) {
      if (typeof obj.version !== "string" || !obj.version) {
        throw new ManifestError(
          `agent.toml at ${where}: ${label}.version must be a non-empty string (npm semver range)`,
        );
      }
      out.version = obj.version;
    }
    rejectStrayKeys(obj, ["npm", "version"], label, where);
    return out;
  }
  if (typeof obj.path !== "string" || !obj.path) {
    throw new ManifestError(
      `agent.toml at ${where}: ${label}.path must be a non-empty string`,
    );
  }
  const out: { path: string; subpath?: string } = { path: obj.path };
  if (obj.subpath !== undefined) {
    if (typeof obj.subpath !== "string" || !obj.subpath) {
      throw new ManifestError(
        `agent.toml at ${where}: ${label}.subpath must be a non-empty string`,
      );
    }
    out.subpath = obj.subpath;
  }
  rejectStrayKeys(obj, ["path", "subpath"], label, where);
  return out;
}

function rejectStrayKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  where: string,
): void {
  const set = new Set(allowed);
  for (const k of Object.keys(obj)) {
    if (!set.has(k)) {
      throw new ManifestError(
        `agent.toml at ${where}: ${label}.${k} is not a known key (expected one of: ${[...set].join(", ")})`,
      );
    }
  }
}

async function readToml(
  abs: string,
  kind: string,
): Promise<Record<string, unknown>> {
  const text = await readFileOrThrow(abs, kind);
  try {
    return TOML.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new ManifestError(
      `Failed to parse ${kind} at ${abs}: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

async function readFileOrThrow(
  filePath: string,
  kind: string,
): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (e) {
    throw new ManifestError(
      `Cannot read ${kind} at ${filePath}: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

function ensureObject(
  v: unknown,
  label: string,
  where: string,
): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new ManifestError(`${where}: ${label} must be a table`);
  }
  return v as Record<string, unknown>;
}

function parseCapabilities(v: unknown, where: string): Capabilities {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ManifestError(
      `agent.toml at ${where}: [capabilities] must be a table`,
    );
  }
  const obj = v as Record<string, unknown>;
  const out: Capabilities = {};
  for (const [k, val] of Object.entries(obj)) {
    out[k] = parseCapabilitySet(val, where, `[capabilities].${k}`);
  }
  return out;
}

function parseCapabilitySet(
  v: unknown,
  where: string,
  label: string,
): CapabilitySet {
  if (v === "*") return "*";
  if (v === null) return {};
  if (typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    const out: Record<string, CapabilityValue> = {};
    for (const [k, val] of Object.entries(obj)) {
      out[k] = parseCapabilityValue(val, where, `${label}.${k}`);
    }
    return out;
  }
  throw new ManifestError(
    `agent.toml at ${where}: ${label} must be "*" or a table of kind grants, got ${typeof v}`,
  );
}

function parseCapabilityValue(
  v: unknown,
  where: string,
  label: string,
): CapabilityValue {
  if (v === "*") return "*";
  if (typeof v === "string") return v;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v as unknown[];
  if (v !== null && typeof v === "object") {
    return v as Record<string, unknown>;
  }
  throw new ManifestError(
    `agent.toml at ${where}: ${label} must be "*", an array, or a table; got ${typeof v}`,
  );
}
