import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as TOML from "toml";

import { expandHome } from "../../internal/util.js";

import YAML from "yaml";

import type {
  Agent,
  FactoryContext,
  Session,
  SessionFactory,
} from "../../types/interfaces.js";
import type {
  CapabilitySet,
  ToolEntry,
  ToolEntryTable,
  ToolGroup,
  ToolGroupVerdict,
} from "../../types/manifest.js";
import { ManifestError } from "../../errors.js";
import { probeTool, toolGroupQualifies } from "../../manifest/tool-groups.js";
import { parseProviders, parseToolTable } from "../../manifest/parser.js";
import { buildNativeTools } from "../tools/native.js";

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
  group: ToolGroup;
}

export interface SkillsSessionOptions {
  roots: readonly string[];
  purpose: "run" | "audit";
}

const SKILL_DIR_PLACEHOLDER = /\$\{SKILL_DIR\}/g;
const LOOM_TOOLS_KEY = "loom.tools";
const LOOM_PROVIDERS_KEY = "loom.providers";
const SIDECAR_FILENAME = "loom.toml";

export class SkillsSession implements Session {
  private cache: Skill[] | null = null;

  constructor(private readonly options: SkillsSessionOptions) {}

  async prepareTurn(): Promise<void> {
    this.cache = await scanRoots(this.options.roots);
  }

  async systemPromptSection(agent: Agent): Promise<string> {
    const skills = await this.ensureCache();
    if (skills.length === 0) return "";
    const verdicts = agent.toolVerdicts ?? [];
    const usable: Skill[] = [];
    const trimmed: Array<{ skill: Skill; reason: string }> = [];
    for (const skill of skills) {
      const reason = this.disqualification(skill, agent, verdicts);
      if (reason === null) usable.push(skill);
      else trimmed.push({ skill, reason });
    }
    if (this.options.purpose === "audit") {
      return renderCatalog(usable, trimmed);
    }
    return usable.length === 0 ? "" : renderCatalog(usable, []);
  }

  async tools(): Promise<ToolGroup[]> {
    const skills = await this.ensureCache();
    return skills.map((s) => s.group);
  }

  // Subtractive only: skills that appeared after boot can never gain grants
  // mid-session; at most they reference already-granted authority.
  private disqualification(
    skill: Skill,
    agent: Agent,
    verdicts: ToolGroupVerdict[],
  ): string | null {
    const verdict = verdicts.find((v) => v.label === skill.group.label);
    if (verdict) {
      if (verdict.accepted) return null;
      const failed = verdict.declarations.filter((d) => !d.ok);
      return failed.map((d) => `'${d.instance}': ${d.reason}`).join("; ");
    }
    if (agent.capabilities === undefined) return null;
    if (declaresNewInstances(skill.group)) {
      return "appeared after boot and declares tools; restart to bind them";
    }
    const registry = buildNativeTools();
    const probe = (instance: string, underlying: string) =>
      probeTool(registry, instance, underlying, agent);
    if (!toolGroupQualifies(skill.group, agent.capabilities, probe)) {
      return "declarations exceed the capability ceiling";
    }
    return null;
  }

  private async ensureCache(): Promise<Skill[]> {
    if (!this.cache) this.cache = await scanRoots(this.options.roots);
    return this.cache;
  }
}

function declaresNewInstances(group: ToolGroup): boolean {
  return Object.values(group.tools).some(
    (entry) => typeof entry === "string" || entry.provider !== undefined,
  );
}

async function scanRoots(roots: readonly string[]): Promise<Skill[]> {
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

async function loadSkill(dir: string): Promise<Skill> {
  const skillMdPath = path.join(dir, "SKILL.md");
  const text = await fs.readFile(skillMdPath, "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    throw new Error(`SKILL.md has no YAML frontmatter: ${skillMdPath}`);
  }
  const frontmatter = parseFrontmatter(match[1] ?? "");
  const group = await compileToolGroup(dir, frontmatter);
  return { skillMdPath, rootDir: dir, frontmatter, group };
}

// Precedence: `loom.toml` sidecar (enhances a skill you didn't author), then
// `loom.tools` frontmatter, then a derived read-only grant over the skill dir.
// `${SKILL_DIR}` substitutes textually before parsing.
async function compileToolGroup(
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

  return {
    label,
    tools: {
      read_file: { capabilities: { paths: [dir] } },
    },
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

function renderCatalog(
  skills: readonly Skill[],
  trimmed: ReadonlyArray<{ skill: Skill; reason: string }>,
): string {
  const home = os.homedir();
  const lines: string[] = [];
  lines.push(
    "Agent Skills are available. Each is a folder containing SKILL.md " +
      "(metadata + instructions) plus optional scripts/, references/, " +
      "and assets/. To activate a skill, read its SKILL.md with the " +
      "file tool; load referenced files only as needed. Tools a skill " +
      "provides are already in your tool list.",
  );
  lines.push("");
  for (const skill of skills) {
    const fm = skill.frontmatter;
    const display = displayPath(skill.skillMdPath, home);
    lines.push(`- **${fm.name}** (\`${display}\`) — ${fm.description}`);
    if (fm.compatibility) lines.push(`  - compatibility: ${fm.compatibility}`);
  }
  for (const { skill, reason } of trimmed) {
    const fm = skill.frontmatter;
    lines.push(`- **${fm.name}** — INACTIVE: ${reason}`);
  }
  return lines.join("\n");
}

function displayPath(p: string, home: string): string {
  if (home && (p === home || p.startsWith(home + path.sep))) {
    return "~" + p.slice(home.length);
  }
  return p;
}

function resolveRoot(raw: string, manifestDir: string): string {
  const expanded = expandHome(raw);
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(manifestDir, expanded);
}

/**
 * Skills roots from a `[session.skills]`-shaped config, resolved against the
 * manifest directory. Also used to extend the default capability ceiling.
 */
export function resolveConfiguredSkillRoots(
  config: Record<string, unknown>,
  manifestDir: string,
): string[] {
  return collectRoots(config).map((r) => resolveRoot(r, manifestDir));
}

export const skillsSessionFactory: SessionFactory = {
  name: "skills",
  passThrough: true,
  create(config: Record<string, unknown>, ctx: FactoryContext): Session {
    if (config.default_tools !== undefined) {
      throw new ManifestError(
        `[session.skills] 'default_tools' no longer exists — skills declare ` +
          `the tools they need themselves (frontmatter 'loom.tools' or a ` +
          `loom.toml sidecar), checked against your [capabilities] ceiling.`,
      );
    }
    const roots = resolveConfiguredSkillRoots(config, ctx.manifestDir);
    return new SkillsSession({ roots, purpose: ctx.purpose ?? "run" });
  },
};

function collectRoots(config: Record<string, unknown>): string[] {
  if (config.roots !== undefined) {
    if (
      !Array.isArray(config.roots) ||
      !config.roots.every((r) => typeof r === "string" && r.length > 0)
    ) {
      throw new ManifestError(
        `[session] provider 'skills' config 'roots' must be a non-empty array of strings`,
      );
    }
    return config.roots as string[];
  }
  if (config.root !== undefined) {
    if (typeof config.root !== "string" || config.root.length === 0) {
      throw new ManifestError(
        `[session] provider 'skills' config 'root' must be a non-empty string`,
      );
    }
    return [config.root];
  }
  return ["~/.skills"];
}
