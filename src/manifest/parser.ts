/**
 * Manifest parsing — agent.toml, tool.toml, SKILL.md.
 *
 * Each parser does TOML / frontmatter parsing + minimal validation. It DOES
 * NOT do dependency resolution or capability checking; that's the resolver's
 * job. Paths inside the manifest stay as strings; the resolver decides
 * whether they resolve as local paths, registry names, or inline content.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import TOML from "@iarna/toml";
import matter from "gray-matter";

import { ManifestError } from "../errors.js";
import type {
  AgentManifest,
  Capabilities,
  SkillManifest,
  SubagentReference,
  ToolManifest,
} from "../types/manifest.js";

// ────────────────────────────────────────────────────────────────────────────
// agent.toml
// ────────────────────────────────────────────────────────────────────────────

export async function parseAgentManifest(manifestPath: string): Promise<AgentManifest> {
  const abs = path.resolve(manifestPath);
  const text = await readFileOrThrow(abs, "agent.toml");
  let raw: Record<string, unknown>;
  try {
    raw = TOML.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new ManifestError(`Failed to parse agent.toml at ${abs}: ${(e as Error).message}`, {
      cause: e,
    });
  }

  const agent = ensureObject(raw.agent, "[agent]", abs);
  if (typeof agent.name !== "string" || !agent.name) {
    throw new ManifestError(`agent.toml at ${abs} is missing required [agent].name`);
  }

  // [agent].system_prompt — single field, accepts either a path-like value
  // or a literal string. The two-field `identity` / `identity_inline` shape
  // was retired in favour of this one.
  if (agent.identity != null || agent.identity_inline != null) {
    throw new ManifestError(
      `agent.toml at ${abs}: [agent].identity / [agent].identity_inline have been replaced by [agent].system_prompt (path or inline string)`,
    );
  }
  if (agent.system_prompt != null && typeof agent.system_prompt !== "string") {
    throw new ManifestError(
      `agent.toml at ${abs}: [agent].system_prompt must be a string (got ${typeof agent.system_prompt})`,
    );
  }

  const harness = ensureObject(raw.harness, "[harness]", abs);
  if (typeof harness.provider !== "string" || !harness.provider) {
    throw new ManifestError(`agent.toml at ${abs} is missing required [harness].provider`);
  }

  const session = ensureObject(raw.session, "[session]", abs);
  if (typeof session.provider !== "string" || !session.provider) {
    throw new ManifestError(`agent.toml at ${abs} is missing required [session].provider`);
  }

  const sandbox = parseCapabilities(raw.sandbox, "[sandbox]", abs);

  const skillsRaw = raw.skills ?? {};
  if (typeof skillsRaw !== "object" || Array.isArray(skillsRaw)) {
    throw new ManifestError(`agent.toml at ${abs}: [skills] must be a table`);
  }
  const skills: Record<string, string> = {};
  for (const [k, v] of Object.entries(skillsRaw as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new ManifestError(
        `agent.toml at ${abs}: [skills].${k} must be a string (path or name), got ${typeof v}`,
      );
    }
    skills[k] = v;
  }

  // [providers] — pluggable resolvers (e.g. mcp). Each entry is keyed by the
  // extension's bare-name; value is an arbitrary config table.
  const providersRaw = raw.providers ?? {};
  if (typeof providersRaw !== "object" || Array.isArray(providersRaw)) {
    throw new ManifestError(`agent.toml at ${abs}: [providers] must be a table`);
  }
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(providersRaw as Record<string, unknown>)) {
    if (v === null || v === undefined) {
      providers[k] = {};
    } else if (typeof v !== "object" || Array.isArray(v)) {
      throw new ManifestError(
        `agent.toml at ${abs}: [providers].${k} must be a table, got ${typeof v}`,
      );
    } else {
      providers[k] = v as Record<string, unknown>;
    }
  }

  const manifest: AgentManifest = {
    manifestPath: abs,
    agent: {
      name: agent.name,
      ...(typeof agent.description === "string" ? { description: agent.description } : {}),
      ...(typeof agent.system_prompt === "string"
        ? { systemPrompt: agent.system_prompt }
        : {}),
    },
    harness: { ...(harness as Record<string, unknown>), provider: harness.provider as string },
    session: { ...(session as Record<string, unknown>), provider: session.provider as string },
    sandbox,
    skills,
    providers,
  };
  return manifest;
}

// ────────────────────────────────────────────────────────────────────────────
// tool.toml
// ────────────────────────────────────────────────────────────────────────────

export async function parseToolManifest(toolDir: string): Promise<ToolManifest> {
  const dir = path.resolve(toolDir);
  const manifestPath = path.join(dir, "tool.toml");
  const text = await readFileOrThrow(manifestPath, "tool.toml");
  let raw: Record<string, unknown>;
  try {
    raw = TOML.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new ManifestError(`Failed to parse tool.toml at ${manifestPath}: ${(e as Error).message}`, {
      cause: e,
    });
  }

  const tool = ensureObject(raw.tool, "[tool]", manifestPath);
  if (typeof tool.name !== "string" || !tool.name) {
    throw new ManifestError(`tool.toml at ${manifestPath} missing required [tool].name`);
  }
  if (typeof tool.description !== "string" || !tool.description) {
    throw new ManifestError(`tool.toml at ${manifestPath} missing required [tool].description`);
  }

  const schema = ensureObject(tool.schema, "[tool.schema]", manifestPath);
  const invocation = ensureObject(tool.invocation, "[tool.invocation]", manifestPath);
  if (typeof invocation.command !== "string" || !invocation.command) {
    throw new ManifestError(
      `tool.toml at ${manifestPath} missing required [tool.invocation].command`,
    );
  }
  const args = invocation.args;
  const parsedArgs: string[] = [];
  if (args !== undefined) {
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
      throw new ManifestError(
        `tool.toml at ${manifestPath}: [tool.invocation].args must be an array of strings`,
      );
    }
    parsedArgs.push(...(args as string[]));
  }

  // Secrets — required + optional arrays.
  const secretsRaw = (tool.secrets ?? {}) as Record<string, unknown>;
  const required = parseStringArray(secretsRaw.required, "[tool.secrets].required", manifestPath, true);
  const optional = parseStringArray(secretsRaw.optional, "[tool.secrets].optional", manifestPath, true);

  const capabilities = parseCapabilities(tool.capabilities, "[tool.capabilities]", manifestPath);

  // Determine whether the tool ships its own bin/ directory.
  const binDir = path.join(dir, "bin");
  let shipsBinary = false;
  try {
    const stat = await fs.stat(binDir);
    shipsBinary = stat.isDirectory();
  } catch {
    shipsBinary = false;
  }

  return {
    manifestPath,
    toolDir: dir,
    tool: {
      name: tool.name,
      description: tool.description,
      schema: schema as ToolManifest["tool"]["schema"],
      invocation: { command: invocation.command, args: parsedArgs },
      secrets: { required, optional },
      capabilities,
    },
    shipsBinary,
    ...(shipsBinary ? { binDir } : {}),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// SKILL.md
// ────────────────────────────────────────────────────────────────────────────

export async function parseSkillManifest(skillDir: string): Promise<SkillManifest> {
  const dir = path.resolve(skillDir);
  const manifestPath = path.join(dir, "SKILL.md");
  const text = await readFileOrThrow(manifestPath, "SKILL.md");
  const parsed = matter(text);
  const data = parsed.data as Record<string, unknown>;

  const name = typeof data.name === "string" ? data.name : null;
  const description = typeof data.description === "string" ? data.description : null;
  if (!name) {
    throw new ManifestError(`SKILL.md at ${manifestPath} missing required frontmatter 'name'`);
  }
  if (!description) {
    throw new ManifestError(`SKILL.md at ${manifestPath} missing required frontmatter 'description'`);
  }

  const requiresRaw = data.requires;
  const requires: Record<string, string> = {};
  if (requiresRaw !== undefined && requiresRaw !== null) {
    if (typeof requiresRaw !== "object" || Array.isArray(requiresRaw)) {
      throw new ManifestError(
        `SKILL.md at ${manifestPath}: 'requires' must be a mapping of tool name → path`,
      );
    }
    for (const [k, v] of Object.entries(requiresRaw as Record<string, unknown>)) {
      if (typeof v !== "string") {
        throw new ManifestError(
          `SKILL.md at ${manifestPath}: requires.${k} must be a string, got ${typeof v}`,
        );
      }
      requires[k] = v;
    }
  }

  // Optional v1: subagents declared inline (mapping) or by file path (string).
  let subagents: Record<string, SubagentReference> | undefined;
  if (data.subagents !== undefined && data.subagents !== null) {
    if (typeof data.subagents === "string") {
      // Path to a subagents.toml file — resolved by the resolver, not here.
      // We tag it as a path reference under the synthetic name "__file__".
      subagents = { __file__: { kind: "path", path: data.subagents } };
    } else if (typeof data.subagents === "object" && !Array.isArray(data.subagents)) {
      subagents = {};
      for (const [k, v] of Object.entries(data.subagents as Record<string, unknown>)) {
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

/** Parse a standalone `subagents.toml` file, used when SKILL.md `subagents` is a path. */
export async function parseSubagentsFile(
  filePath: string,
): Promise<Record<string, SubagentReference>> {
  const abs = path.resolve(filePath);
  const text = await readFileOrThrow(abs, "subagents.toml");
  let raw: Record<string, unknown>;
  try {
    raw = TOML.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new ManifestError(`Failed to parse subagents.toml at ${abs}: ${(e as Error).message}`, {
      cause: e,
    });
  }
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
    if (v.startsWith("acp://") || v.startsWith("acp+ws://") || v.startsWith("acp+unix://")) {
      return { kind: "acp", url: v };
    }
    if (v.startsWith("./") || v.startsWith("../") || v.startsWith("/") || v.endsWith(".toml")) {
      return { kind: "path", path: v };
    }
    return { kind: "registry", name: v };
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if (typeof obj.path === "string") return { kind: "path", path: obj.path };
    if (typeof obj.name === "string") return { kind: "registry", name: obj.name };
    if (typeof obj.acp === "string") return { kind: "acp", url: obj.acp };
    if (typeof obj.inline === "string") {
      // inline literal manifest (unparsed) — resolver handles parsing.
      // We stash it as a synthetic path-with-content; resolver will inspect.
      return { kind: "path", path: `inline:${obj.inline}` };
    }
  }
  throw new ManifestError(
    `subagent ${key} at ${manifestPath}: expected string or { path | name | acp | inline }`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────────

function ensureObject(v: unknown, label: string, where: string): Record<string, unknown> {
  if (v === undefined || v === null) {
    return {};
  }
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
  if (v === undefined || v === null) {
    if (allowMissing) return [];
    throw new ManifestError(`${where}: ${label} is required`);
  }
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new ManifestError(`${where}: ${label} must be an array of strings`);
  }
  return v as string[];
}

function parseCapabilities(v: unknown, label: string, where: string): Capabilities {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new ManifestError(`${where}: ${label} must be a table`);
  }
  const obj = v as Record<string, unknown>;
  const out: Capabilities = {};
  if (obj.filesystem !== undefined) {
    out.filesystem = parseStringArray(obj.filesystem, `${label}.filesystem`, where);
  }
  if (obj.network !== undefined) {
    out.network = parseStringArray(obj.network, `${label}.network`, where);
  }
  if (obj.secrets !== undefined) {
    out.secrets = parseStringArray(obj.secrets, `${label}.secrets`, where);
  }
  if (obj.subagent !== undefined) {
    if (obj.subagent === "*") {
      out.subagent = "*";
    } else {
      out.subagent = parseStringArray(obj.subagent, `${label}.subagent`, where);
    }
  }
  return out;
}

async function readFileOrThrow(filePath: string, kind: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (e) {
    throw new ManifestError(`Cannot read ${kind} at ${filePath}: ${(e as Error).message}`, {
      cause: e,
    });
  }
}
