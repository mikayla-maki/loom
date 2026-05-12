/**
 * Parser for `agent.toml` (manifest v5). Validates shape and classifies
 * every `Reference` value (bare handle vs. SourceSpec string fast-path
 * vs. SourceSpec table) by *shape*. Does NOT touch the filesystem to
 * resolve sources or look up handles — that happens in the resolver
 * at boot time.
 *
 * See `internal-docs/manifest-v5.md` §1 for the grammar.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import TOML from "@iarna/toml";

import { ManifestError } from "../errors.js";
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

// ─── Top-level entry point ─────────────────────────────────────────────────

export async function parseAgentManifest(
  manifestPath: string,
): Promise<AgentManifest> {
  const abs = path.resolve(manifestPath);
  const raw = await readToml(abs, "agent.toml");

  const agent = ensureObject(raw.agent, "[agent]", abs);
  if (typeof agent.name !== "string" || !agent.name) {
    throw new ManifestError(
      `agent.toml at ${abs} is missing required [agent].name`,
    );
  }
  const systemPrompt = parseSystemPromptSpec(agent.system_prompt, abs);
  const secrets = parseSecretAllowlist(agent.secrets, abs);
  const storageId = parseStorageId(agent.storage_id, abs);

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
  };
}

// ─── Agent-section helpers (system prompt + secrets + storage) ──────

/**
 * Parse `[agent].storage_id`. Must be a non-empty string with no
 * path separators — same character class as a directory name. The
 * storage layer further sanitizes punctuation; the parser only
 * enforces the structural invariants the user might typo.
 */
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

// ─── [providers] ──────────────────────────────────────────────────────────

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
  // Two accepted on-disk shapes (see `ProviderEntry` JSDoc):
  //
  //   1. SourceSpec form — string fast-path or a `{ npm }` / `{ path }`
  //      table. Code-on-disk; loaded by the provider loader.
  //   2. Configured-factory form — a table with a `provider` field.
  //      Same shape as [harness] / [session] / [tools.X]; the
  //      `provider` field names a Tools factory (built-in or, in
  //      future, source-loaded) and the rest of the table is
  //      per-handle config.
  //
  // Discriminator: a table carrying a `provider` field IS the
  // configured-factory form; any other table shape is parsed as a
  // SourceSpec table.
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if (obj.provider !== undefined) {
      const provider = parseReference(obj.provider, `${label}.provider`, where);
      const { provider: _p, ...config } = obj;
      void _p;
      return { provider, ...config };
    }
    // SourceSpec table (no `provider` field).
    return parseSourceSpecTable(obj, label, where);
  }
  // Otherwise the value must be a SourceSpec-shaped string. Bare
  // handles aren't accepted at this layer — they would point at
  // themselves.
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

// ─── [tools] ───────────────────────────────────────────────────────────────

function parseToolTable(v: unknown, where: string): Record<string, ToolEntry> {
  const obj = ensureObject(v, "[tools]", where);
  const out: Record<string, ToolEntry> = {};
  for (const [k, val] of Object.entries(obj)) {
    out[k] = parseToolEntry(val, `[tools].${k}`, where);
  }
  return out;
}

function parseToolEntry(v: unknown, label: string, where: string): ToolEntry {
  // String shorthand: equivalent to `{ provider = "<string>" }`.
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

// ─── [harness] / [session] ────────────────────────────────────────────────

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

/**
 * Parse the `session` field. A manifest has exactly one session;
 * that session is either a single layer (singleton) or a layered
 * composition. Both forms live under one `[session]` block:
 *
 *   - **Singleton.** `[session]` carries a `provider` key. The rest
 *     of the block is its config. This is the trivial one-layer
 *     session.
 *
 *   - **Composition.** `[session]` carries a `layers` key. The value
 *     is an array of layer specs, outer-to-inner. Each entry is
 *     either a string (sugar for `{ provider = "<string>" }`) or an
 *     inline table with its own `provider` + config. TOML's
 *     dotted-key array-of-tables `[[session.layers]]` produces the
 *     same shape and is interchangeable.
 *
 * `provider` and `layers` are mutually exclusive; neither one is an
 * error. The old top-level `[[session]]` form is rejected with a
 * pointer at `[session].layers`.
 */
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
    return parseSessionLayers(obj.layers, where);
  }
  return parseSessionSpec(obj, where);
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
  // String shorthand: equivalent to `{ provider = "<string>" }`.
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

// ─── References (shape-first classification) ──────────────────────────────

/**
 * Parse a `Reference` value. Accepts:
 *
 *   - string (validated by {@link validateReferenceString})
 *   - SourceSpec table (`{ npm = ... }` / `{ path = ... }`)
 *
 * Resolution against the appropriate tables (`[providers]`, built-in
 * registries) happens later in the resolver — the parser only
 * classifies by shape.
 */
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

/**
 * Validate a reference string. Accepted shapes:
 *
 *   - `"./..."`, `"../..."` — local path (SourceSpec fast-path)
 *   - `"name/sub"`, `"@scope/pkg"` — npm spec (SourceSpec fast-path)
 *   - bare identifier — handle for [providers] / built-in
 *
 * Absolute paths (`"/foo"`) are rejected with a pointer to the table
 * form.
 */
function validateReferenceString(
  s: string,
  label: string,
  where: string,
): void {
  if (s.startsWith("./") || s.startsWith("../")) return; // path
  if (s.startsWith("/")) {
    throw new ManifestError(
      `agent.toml at ${where}: ${label} "${s}" is an absolute path. ` +
        `Use the table form: ${label} = { path = "${s}" }.`,
    );
  }
  if (s.includes("/")) {
    // npm-shaped
    if (!/^[@a-zA-Z0-9_\-./]+$/.test(s)) {
      throw new ManifestError(
        `agent.toml at ${where}: ${label} "${s}" doesn't look like a valid ` +
          `npm package reference`,
      );
    }
    return;
  }
  // Bare handle.
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

/** Validate a `[providers].<handle>` key. */
function validateHandle(s: string, label: string, where: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_\-.]*$/.test(s)) {
    throw new ManifestError(
      `agent.toml at ${where}: ${label} is not a valid handle name ` +
        `(letters, digits, underscore, dash, dot; must start with letter or underscore)`,
    );
  }
}

/**
 * Classify a reference string as a SourceSpec-shaped fast-path
 * (vs. a bare handle). Used by parsers that need to enforce
 * SourceSpec-only (e.g., `[providers]` values can't be bare handles —
 * that would be a self-reference).
 */
function isSourceSpecShapedString(s: string): boolean {
  return s.startsWith("./") || s.startsWith("../") || s.includes("/");
}

// ─── SourceSpec table parsing ─────────────────────────────────────────────

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
  // We just checked `present.length === 0` and `present.length > 1`,
  // so exactly one entry remains here.
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
  // path
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

// ─── TOML I/O and ensureObject ────────────────────────────────────────────

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

// ─── [capabilities] ───────────────────────────────────────────────────────

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
  // Literal-binding shapes (used by argument-binding tool grants, see
  // `applyArgGrant`). Built-in kinds that don't recognise the literal
  // shape will leave the value untouched at audit time.
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
