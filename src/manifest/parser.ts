/**
 * Parsers for `agent.toml` and `SKILL.md`. Validation only — capability
 * checks and tool construction live in providers.
 *
 * The manifest model is `(name, config)` for tools: each entry's value
 * is an opaque config blob (string or object) that loom hands to the
 * provider chain. There's no on-disk tool format.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import TOML from "@iarna/toml";
import matter from "gray-matter";

import { ManifestError } from "../errors.js";
import type { ToolConfig } from "../types/interfaces.js";
import type {
  AgentManifest,
  Capabilities,
  SkillManifest,
  SystemPromptSpec,
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
  const systemPrompt = parseSystemPromptSpec(agent.system_prompt, abs);

  const harness = ensureObject(raw.harness, "[harness]", abs);
  if (typeof harness.provider !== "string" || !harness.provider) {
    throw new ManifestError(
      `agent.toml at ${abs} is missing required [harness].provider`,
    );
  }
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

  const capabilities =
    raw.capabilities === undefined
      ? undefined
      : parseCapabilities(raw.capabilities, abs);
  const tools =
    raw.tools === undefined
      ? undefined
      : parseToolConfigTable(raw.tools, "[tools]", abs);
  const skills = parseStringValueTable(raw.skills, "[skills]", abs);
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
    ...(capabilities ? { capabilities } : {}),
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

  const requires: Record<string, ToolConfig> = {};
  if (data.requires != null) {
    if (typeof data.requires !== "object" || Array.isArray(data.requires)) {
      throw new ManifestError(
        `SKILL.md at ${manifestPath}: 'requires' must be a mapping of tool name → config`,
      );
    }
    for (const [k, v] of Object.entries(
      data.requires as Record<string, unknown>,
    )) {
      requires[k] = parseToolConfigValue(v, manifestPath, k);
    }
  }

  return {
    manifestPath,
    skillDir: dir,
    name,
    description,
    body: parsed.content,
    requires,
  };
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
 * Tables of `name = ToolConfig` (used for [tools] and skills' requires).
 * Each value is `string | Record<string, unknown>` — loom doesn't
 * interpret it; providers do.
 */
function parseToolConfigTable(
  v: unknown,
  label: string,
  where: string,
): Record<string, ToolConfig> {
  const obj = ensureObject(v, label, where);
  const out: Record<string, ToolConfig> = {};
  for (const [k, val] of Object.entries(obj)) {
    out[k] = parseToolConfigValue(val, where, `${label}.${k}`);
  }
  return out;
}

function parseToolConfigValue(
  v: unknown,
  where: string,
  label: string,
): ToolConfig {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  throw new ManifestError(
    `${where}: ${label} must be a string or a table, got ${typeof v}`,
  );
}

/**
 * Parse the agent's `[capabilities]` table — opaque per-tool ceilings.
 * Loom doesn't validate the values; tools' `capabilitiesContain` does
 * the comparison at boot.
 */
function parseCapabilities(v: unknown, where: string): Capabilities {
  const obj = ensureObject(v, "[capabilities]", where);
  return obj as Capabilities;
}
