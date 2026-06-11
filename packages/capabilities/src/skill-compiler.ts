import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as TOML from "toml";
import YAML from "yaml";

import { parseProviders, parseToolTable } from "./parser.js";
import type { ToolGroup } from "./types.js";

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
}

export interface Skill {
  skillMdPath: string;
  rootDir: string;
  frontmatter: SkillFrontmatter;
  body: string;
  group: ToolGroup;
}

const SKILL_DIR_PLACEHOLDER = /\$\{SKILL_DIR\}/g;
const LOOM_TOOLS_KEY = "loom.tools";
const LOOM_PROVIDERS_KEY = "loom.providers";
const SIDECAR_FILENAME = "loom.toml";

export const READ_SKILL = "read_skill";

/** Recursively discover and compile every skill folder under the roots. */
export async function scanRoots(roots: readonly string[]): Promise<Skill[]> {
  const acc: Skill[] = [];
  for (const root of roots) {
    try {
      await walk(root, acc);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
  }
  acc.sort((a, b) => a.frontmatter.name.localeCompare(b.frontmatter.name));
  return acc;
}

async function walk(dir: string, acc: Skill[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const hasSkillMd = entries.some((e) => e.isFile() && e.name === "SKILL.md");
  if (hasSkillMd) {
    try {
      acc.push(await loadSkill(dir));
    } catch {
      // Malformed skill: skip so boot stays resilient.
    }
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await walk(path.join(dir, entry.name), acc);
    }
  }
}

export async function loadSkill(dir: string): Promise<Skill> {
  const skillMdPath = path.join(dir, "SKILL.md");
  const text = await fs.readFile(skillMdPath, "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    throw new Error(`SKILL.md has no YAML frontmatter: ${skillMdPath}`);
  }
  const frontmatter = parseFrontmatter(match[1] ?? "");
  const body = text.slice(match[0].length);
  const group = await compileToolGroup(dir, frontmatter);
  return { skillMdPath, rootDir: dir, frontmatter, body, group };
}

// Precedence: `loom.toml` sidecar (enhances a skill you didn't author), then
// `loom.tools` frontmatter, then a derived read-only grant over the skill dir.
// `${SKILL_DIR}` substitutes textually before parsing.
export async function compileToolGroup(
  dir: string,
  frontmatter: SkillFrontmatter,
): Promise<ToolGroup> {
  const label = `skill '${frontmatter.name}'`;

  const sidecarPath = path.join(dir, SIDECAR_FILENAME);
  let sidecarText: string | null = null;
  try {
    sidecarText = await fs.readFile(sidecarPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (sidecarText !== null) {
    const parsed = parseTomlSource(sidecarText, dir, `${label} loom.toml`);
    const rawTools = (parsed as { tools?: unknown }).tools;
    if (rawTools === undefined) {
      throw new Error(`${label}: loom.toml has no [tools] table`);
    }
    return buildGroup(
      label,
      rawTools,
      (parsed as { providers?: unknown }).providers,
    );
  }

  const inlineTools = frontmatter.metadata?.[LOOM_TOOLS_KEY];
  if (inlineTools !== undefined && inlineTools.trim().length > 0) {
    const rawTools = parseTomlSource(
      inlineTools,
      dir,
      `${label} ${LOOM_TOOLS_KEY}`,
    );
    const inlineProviders = frontmatter.metadata?.[LOOM_PROVIDERS_KEY];
    const rawProviders =
      inlineProviders !== undefined && inlineProviders.trim().length > 0
        ? parseTomlSource(
            inlineProviders,
            dir,
            `${label} ${LOOM_PROVIDERS_KEY}`,
          )
        : undefined;
    return buildGroup(label, rawTools, rawProviders);
  }

  // No declarations: activation and bundled reads go through read_skill,
  // so the skill requests no authority at all.
  return {
    label,
    tools: { [READ_SKILL]: {} },
  };
}

// Same parser as the manifest so skill declarations obey the [tools] /
// [providers] grammar; provider-less entries grant onto existing instances.
function buildGroup(
  label: string,
  rawTools: unknown,
  rawProviders: unknown,
): ToolGroup {
  const group: ToolGroup = {
    label,
    tools: parseToolTable(rawTools, label, { requireProvider: false }),
  };
  if (rawProviders !== undefined) {
    group.providers = parseProviders(rawProviders, label);
  }
  return group;
}

function parseTomlSource(
  source: string,
  dir: string,
  where: string,
): Record<string, unknown> {
  const substituted = source.replace(SKILL_DIR_PLACEHOLDER, dir);
  try {
    return TOML.parse(substituted) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${where} is not valid TOML: ${(e as Error).message}`);
  }
}

export function parseFrontmatter(yaml: string): SkillFrontmatter {
  let raw: unknown;
  try {
    raw = YAML.parse(yaml);
  } catch (e) {
    throw new Error(
      `SKILL.md frontmatter is not valid YAML: ${(e as Error).message}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("SKILL.md frontmatter must be a YAML mapping");
  }
  const obj = raw as Record<string, unknown>;

  const name = stringOf(obj.name);
  const description = stringOf(obj.description);
  if (!name) throw new Error("SKILL.md frontmatter missing required 'name'");
  if (!description)
    throw new Error("SKILL.md frontmatter missing required 'description'");

  const fm: SkillFrontmatter = { name, description };

  const license = stringOf(obj.license);
  if (license) fm.license = license;
  const compatibility = stringOf(obj.compatibility);
  if (compatibility) fm.compatibility = compatibility;
  const allowedTools = stringOf(obj["allowed-tools"]);
  if (allowedTools) fm.allowedTools = allowedTools;

  if (
    obj.metadata &&
    typeof obj.metadata === "object" &&
    !Array.isArray(obj.metadata)
  ) {
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.metadata)) {
      metadata[k] = stringify(v);
    }
    fm.metadata = metadata;
  }

  return fm;
}

function stringOf(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return String(v);
}
