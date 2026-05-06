/**
 * Parsers for `agent.toml`, `tool.toml`, and `SKILL.md`. Validation only
 * — dependency walking and capability checks live in the resolver.
 *
 * Parsers produce typed `AgentManifest` / `SkillManifest` / `ToolManifest`
 * objects. The unified manifest type allows nested skills/tools/subagents
 * but parser output is always *flat* — TOML refs are strings, never
 * inline objects. Inline construction is the SDK consumer's path.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import TOML from "@iarna/toml";
import matter from "gray-matter";

import { ManifestError } from "../errors.js";
import type {
  AgentManifest,
  SandboxCeiling,
  SkillManifest,
  SubagentReference,
  SystemPromptSpec,
  ToolCapabilities,
  ToolManifest,
} from "../types/manifest.js";

// ─── agent.toml ────────────────────────────────────────────────────────────

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
  if (agent.identity != null || agent.identity_inline != null) {
    throw new ManifestError(
      `agent.toml at ${abs}: [agent].identity / [agent].identity_inline have been replaced by [agent].system_prompt (path or inline string)`,
    );
  }
  if (agent.remove_builtin_tools != null) {
    throw new ManifestError(
      `agent.toml at ${abs}: [agent].remove_builtin_tools is no longer supported. Declare an explicit (possibly empty) [tools] table instead — absence of [tools] auto-loads the default builtin set; an empty [tools] table opts out entirely.`,
    );
  }
  const systemPrompt = parseSystemPromptSpec(agent.system_prompt, abs);

  const harness = ensureObject(raw.harness, "[harness]", abs);
  if (typeof harness.provider !== "string" || !harness.provider) {
    throw new ManifestError(
      `agent.toml at ${abs} is missing required [harness].provider`,
    );
  }
  // [session] is optional. If absent, the resolver applies a default of
  // `{ provider: "memory" }`. If present, `provider` is required.
  let session: AgentManifest["session"] | undefined;
  if (raw.session !== undefined) {
    const s = ensureObject(raw.session, "[session]", abs);
    if (typeof s.provider !== "string" || !s.provider) {
      throw new ManifestError(
        `agent.toml at ${abs}: [session] table is present but missing 'provider'`,
      );
    }
    session = { ...(s as Record<string, unknown>), provider: s.provider };
  }

  const sandbox =
    raw.sandbox === undefined
      ? undefined
      : parseSandboxCeiling(raw.sandbox, abs);
  // [tools] in file form is string-valued; SDK consumers can pass
  // inline ToolManifest objects through the JS shape.
  const tools =
    raw.tools === undefined
      ? undefined
      : parseStringValueTable(raw.tools, "[tools]", abs);
  const skills = parseStringValueTable(raw.skills, "[skills]", abs);
  if (raw.providers !== undefined) {
    throw new ManifestError(
      `agent.toml at ${abs}: [providers] is no longer a separate table — list provider names under [extensions] instead. Each [extensions].<name> entry resolves to a registered provider factory or to an npm package with a 'loom.extension' field.`,
    );
  }
  const extensions = parseConfigTable(raw.extensions, "[extensions]", abs);

  return {
    manifestPath: abs,
    name: agent.name,
    ...(typeof agent.description === "string"
      ? { description: agent.description }
      : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    harness: {
      ...(harness as Record<string, unknown>),
      provider: harness.provider as string,
    },
    ...(session ? { session } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(tools !== undefined ? { tools } : {}),
    skills,
    extensions,
  };
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

// ─── tool.toml ─────────────────────────────────────────────────────────────

export async function parseToolManifest(
  toolDir: string,
): Promise<ToolManifest> {
  const dir = path.resolve(toolDir);
  const manifestPath = path.join(dir, "tool.toml");
  const raw = await readToml(manifestPath, "tool.toml");

  const tool = ensureObject(raw.tool, "[tool]", manifestPath);
  if (typeof tool.name !== "string" || !tool.name) {
    throw new ManifestError(
      `tool.toml at ${manifestPath} missing required [tool].name`,
    );
  }
  if (typeof tool.description !== "string" || !tool.description) {
    throw new ManifestError(
      `tool.toml at ${manifestPath} missing required [tool].description`,
    );
  }

  const schema = ensureObject(tool.schema, "[tool.schema]", manifestPath);
  const invocation = ensureObject(
    tool.invocation,
    "[tool.invocation]",
    manifestPath,
  );
  if (typeof invocation.command !== "string" || !invocation.command) {
    throw new ManifestError(
      `tool.toml at ${manifestPath} missing required [tool.invocation].command`,
    );
  }
  let args: string[] = [];
  if (invocation.args !== undefined) {
    if (
      !Array.isArray(invocation.args) ||
      !invocation.args.every((a) => typeof a === "string")
    ) {
      throw new ManifestError(
        `tool.toml at ${manifestPath}: [tool.invocation].args must be an array of strings`,
      );
    }
    args = invocation.args as string[];
  }

  const secretsRaw = (tool.secrets ?? {}) as Record<string, unknown>;
  const required = parseStringArray(
    secretsRaw.required,
    "[tool.secrets].required",
    manifestPath,
    true,
  );
  const optional = parseStringArray(
    secretsRaw.optional,
    "[tool.secrets].optional",
    manifestPath,
    true,
  );
  const capabilities = parseToolCapabilities(
    tool.capabilities,
    "[tool.capabilities]",
    manifestPath,
  );

  const binDir = path.join(dir, "bin");
  let shipsBinary = false;
  try {
    shipsBinary = (await fs.stat(binDir)).isDirectory();
  } catch {
    /* no bin/ */
  }

  return {
    manifestPath,
    toolDir: dir,
    name: tool.name,
    description: tool.description,
    schema: schema as ToolManifest["schema"],
    invocation: { command: invocation.command, args },
    secrets: {
      required,
      ...(optional.length > 0 ? { optional } : {}),
    },
    capabilities,
    shipsBinary,
    ...(shipsBinary ? { binDir } : {}),
  };
}

// ─── SKILL.md ──────────────────────────────────────────────────────────────

export async function parseSkillManifest(
  skillDir: string,
): Promise<SkillManifest> {
  const dir = path.resolve(skillDir);
  const manifestPath = path.join(dir, "SKILL.md");
  const text = await readFileOrThrow(manifestPath, "SKILL.md");
  const parsed = matter(text);
  const data = parsed.data as Record<string, unknown>;

  const name = typeof data.name === "string" ? data.name : null;
  const description =
    typeof data.description === "string" ? data.description : null;
  if (!name) {
    throw new ManifestError(
      `SKILL.md at ${manifestPath} missing required frontmatter 'name'`,
    );
  }
  if (!description) {
    throw new ManifestError(
      `SKILL.md at ${manifestPath} missing required frontmatter 'description'`,
    );
  }

  const requires: Record<string, string> = {};
  if (data.requires != null) {
    if (typeof data.requires !== "object" || Array.isArray(data.requires)) {
      throw new ManifestError(
        `SKILL.md at ${manifestPath}: 'requires' must be a mapping of tool name → path`,
      );
    }
    for (const [k, v] of Object.entries(
      data.requires as Record<string, unknown>,
    )) {
      if (typeof v !== "string") {
        throw new ManifestError(
          `SKILL.md at ${manifestPath}: requires.${k} must be a string, got ${typeof v}`,
        );
      }
      requires[k] = v;
    }
  }

  let subagents: Record<string, SubagentReference> | undefined;
  if (data.subagents != null) {
    if (typeof data.subagents === "string") {
      // The string form means "load a separate subagents.toml at this
      // path"; the resolver handles it under the synthetic '__file__' key.
      subagents = { __file__: { kind: "path", path: data.subagents } };
    } else if (
      typeof data.subagents === "object" &&
      !Array.isArray(data.subagents)
    ) {
      subagents = {};
      for (const [k, v] of Object.entries(
        data.subagents as Record<string, unknown>,
      )) {
        subagents[k] = parseSubagentEntry(v, k, manifestPath);
      }
    } else {
      throw new ManifestError(
        `SKILL.md at ${manifestPath}: 'subagents' must be a string (path) or mapping`,
      );
    }
  }

  return {
    manifestPath,
    skillDir: dir,
    name,
    description,
    body: parsed.content,
    requires,
    ...(subagents ? { subagents } : {}),
  };
}

export async function parseSubagentsFile(
  filePath: string,
): Promise<Record<string, SubagentReference>> {
  const abs = path.resolve(filePath);
  const raw = await readToml(abs, "subagents.toml");
  const out: Record<string, SubagentReference> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = parseSubagentEntry(v, k, abs);
  }
  return out;
}

function parseSubagentEntry(
  v: unknown,
  key: string,
  manifestPath: string,
): SubagentReference {
  if (typeof v === "string") {
    if (
      v.startsWith("acp://") ||
      v.startsWith("acp+ws://") ||
      v.startsWith("acp+unix://")
    ) {
      return { kind: "acp", url: v };
    }
    if (
      v.startsWith("./") ||
      v.startsWith("../") ||
      v.startsWith("/") ||
      v.endsWith(".toml")
    ) {
      return { kind: "path", path: v };
    }
    return { kind: "registry", name: v };
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if (typeof obj.path === "string") return { kind: "path", path: obj.path };
    if (typeof obj.name === "string")
      return { kind: "registry", name: obj.name };
    if (typeof obj.acp === "string") return { kind: "acp", url: obj.acp };
    if ("inline" in obj) {
      throw new ManifestError(
        `subagent ${key} at ${manifestPath}: inline manifests are no longer supported. Use a path, a registry name, or an acp:// URL.`,
      );
    }
  }
  throw new ManifestError(
    `subagent ${key} at ${manifestPath}: expected string or { path | name | acp }`,
  );
}

// ─── helpers ───────────────────────────────────────────────────────────────

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

function parseStringArray(
  v: unknown,
  label: string,
  where: string,
  allowMissing = false,
): string[] {
  if (v == null) {
    if (allowMissing) return [];
    throw new ManifestError(`${where}: ${label} is required`);
  }
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new ManifestError(`${where}: ${label} must be an array of strings`);
  }
  return v as string[];
}

/** Tables of `name = "string"` (used for [skills]). */
function parseStringValueTable(
  v: unknown,
  label: string,
  where: string,
): Record<string, string> {
  const obj = ensureObject(v, label, where);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(obj)) {
    if (typeof val !== "string") {
      throw new ManifestError(
        `${where}: ${label}.${k} must be a string, got ${typeof val}`,
      );
    }
    out[k] = val;
  }
  return out;
}

/** Tables of `name = { ...config }` (used for [extensions]). */
function parseConfigTable(
  v: unknown,
  label: string,
  where: string,
): Record<string, Record<string, unknown>> {
  const obj = ensureObject(v, label, where);
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, val] of Object.entries(obj)) {
    if (val == null) {
      out[k] = {};
    } else if (typeof val !== "object" || Array.isArray(val)) {
      throw new ManifestError(
        `${where}: ${label}."${k}" must be a table, got ${typeof val}`,
      );
    } else {
      out[k] = val as Record<string, unknown>;
    }
  }
  return out;
}

/**
 * Parse the agent's `[sandbox]` ceiling. Rejects `subagent` here —
 * subagent permissions live on each skill's `subagents` field; the agent
 * has no separate veto axis.
 */
function parseSandboxCeiling(v: unknown, where: string): SandboxCeiling {
  const obj = ensureObject(v, "[sandbox]", where);
  if ("subagent" in obj) {
    throw new ManifestError(
      `agent.toml at ${where}: [sandbox].subagent is no longer supported. Subagent permissions live on each skill's \`subagents\` field; the agent's [sandbox] only constrains filesystem / network / secrets.`,
    );
  }
  const out: SandboxCeiling = {};
  if (obj.filesystem !== undefined) {
    out.filesystem = parseStringArray(
      obj.filesystem,
      `[sandbox].filesystem`,
      where,
    );
  }
  if (obj.network !== undefined) {
    out.network = parseStringArray(obj.network, `[sandbox].network`, where);
  }
  if (obj.secrets !== undefined) {
    out.secrets = parseStringArray(obj.secrets, `[sandbox].secrets`, where);
  }
  return out;
}

/**
 * Parse `[tool.capabilities]`. Tools may declare `subagent` (a list of
 * subagent names, or `*`) to opt into broker env-var injection at spawn
 * time — that's intent-of-use, not a ceiling.
 */
function parseToolCapabilities(
  v: unknown,
  label: string,
  where: string,
): ToolCapabilities {
  const obj = ensureObject(v, label, where);
  const out: ToolCapabilities = {};
  if (obj.filesystem !== undefined) {
    out.filesystem = parseStringArray(
      obj.filesystem,
      `${label}.filesystem`,
      where,
    );
  }
  if (obj.network !== undefined) {
    out.network = parseStringArray(obj.network, `${label}.network`, where);
  }
  if (obj.secrets !== undefined) {
    out.secrets = parseStringArray(obj.secrets, `${label}.secrets`, where);
  }
  if (obj.subagent !== undefined) {
    out.subagent =
      obj.subagent === "*"
        ? "*"
        : parseStringArray(obj.subagent, `${label}.subagent`, where);
  }
  return out;
}
