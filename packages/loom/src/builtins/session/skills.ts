import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { expandHome } from "../../internal/util.js";

import type {
  Agent,
  FactoryContext,
  Session,
  SessionFactory,
  Tool,
  ToolConfig,
  ToolContext,
  ToolResult,
} from "../../types/interfaces.js";
import type { ToolGroup } from "../../types/manifest.js";
import type { JSONSchema } from "../../types/schema.js";
import { ManifestError } from "../../errors.js";
import { probeTool, toolGroupQualifies } from "../../manifest/tool-groups.js";
import { buildNativeTools } from "../tools/native.js";
import { scanRoots } from "@mcmaki/loom-capabilities";
import type { Skill } from "@mcmaki/loom-capabilities";

// The skill→tools compiler lives in the capabilities package; re-export the
// authoring surface so loom's public API is unchanged.
export {
  compileToolGroup,
  loadSkill,
  parseFrontmatter,
  scanRoots,
  type Skill,
  type SkillFrontmatter,
} from "@mcmaki/loom-capabilities";

export interface SkillsSessionOptions {
  roots: readonly string[];
  purpose: "run" | "audit";
}

const READ_SKILL = "read_skill";
const RESOURCE_LISTING_CAP = 50;

export class SkillsSession implements Session {
  private cache: Skill[] | null = null;

  constructor(private readonly options: SkillsSessionOptions) {}

  async prepareTurn(): Promise<void> {
    this.cache = await scanRoots(this.options.roots);
  }

  async systemPromptSection(agent: Agent): Promise<string> {
    const skills = await this.ensureCache();
    if (skills.length === 0) return "";
    const usable: Skill[] = [];
    const trimmed: Array<{ skill: Skill; reason: string }> = [];
    for (const skill of skills) {
      const reason = disqualificationFor(skill, agent);
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
    if (skills.length === 0) return [];
    return [
      {
        label: "skills session",
        tools: { [READ_SKILL]: { provider: "session" } },
      },
      ...skills.map((s) => s.group),
    ];
  }

  resolveTool(name: string, _config: ToolConfig): Tool | null {
    if (name !== READ_SKILL) return null;
    return new ReadSkillTool(() => this.ensureCache());
  }

  private async ensureCache(): Promise<Skill[]> {
    if (!this.cache) this.cache = await scanRoots(this.options.roots);
    return this.cache;
  }
}

// Subtractive only: skills that appeared after boot can never gain grants
// mid-session; at most they reference already-granted authority.
function disqualificationFor(skill: Skill, agent: Agent): string | null {
  const verdicts = agent.toolVerdicts ?? [];
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

const READ_SKILL_SCHEMA: JSONSchema = {
  type: "object",
  required: ["skill"],
  additionalProperties: false,
  properties: {
    skill: {
      type: "string",
      minLength: 1,
      description: "Skill name from the catalog.",
    },
    path: {
      type: "string",
      minLength: 1,
      description:
        "Relative path to a bundled file inside the skill folder. Omit to " +
        "activate the skill (returns its instructions and resource listing).",
    },
  },
};

class ReadSkillTool implements Tool {
  readonly name = READ_SKILL;
  readonly description =
    "Activate an Agent Skill or read its bundled files. Call with just " +
    "`skill` to load a skill's full instructions plus a listing of its " +
    "bundled resources; pass `path` to read one of those files. Skill " +
    "names are in the skills catalog.";
  readonly inputSchema = READ_SKILL_SCHEMA;

  constructor(private readonly skills: () => Promise<Skill[]>) {}

  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { skill: name, path: relPath } = input as {
      skill?: string;
      path?: string;
    };
    if (!name) {
      return { content: "read_skill: 'skill' is required", isError: true };
    }
    const skills = await this.skills();
    const usable = skills.filter(
      (s) => disqualificationFor(s, ctx.agent) === null,
    );
    const skill = usable.find((s) => s.frontmatter.name === name);
    if (!skill) {
      const known = usable.map((s) => s.frontmatter.name).join(", ");
      return {
        content: `read_skill: unknown skill '${name}'. Available: ${known || "(none)"}`,
        isError: true,
      };
    }
    if (relPath === undefined) {
      return { content: await renderActivation(skill) };
    }
    return await readBundledFile(skill, relPath);
  }
}

// Structured wrapping per the Agent Skills client guide: instructions
// tagged with the skill identity, the directory for resolving relative
// references, and a resource listing that is never eagerly loaded.
async function renderActivation(skill: Skill): Promise<string> {
  const lines: string[] = [];
  lines.push(
    `<skill name="${skill.frontmatter.name}" directory="${skill.rootDir}">`,
  );
  lines.push(skill.body.trim());
  lines.push("</skill>");
  lines.push("");
  lines.push(
    "Relative paths in these instructions resolve against the skill " +
      "directory. Read bundled files with read_skill " +
      `{ "skill": "${skill.frontmatter.name}", "path": "<relative path>" }.`,
  );
  const resources = await listResources(skill.rootDir);
  if (resources.length > 0) {
    lines.push("");
    lines.push("Bundled resources:");
    lines.push(...resources);
  }
  return lines.join("\n");
}

async function listResources(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  let truncated = false;
  const walkDir = async (dir: string, rel: string): Promise<void> => {
    if (out.length > RESOURCE_LISTING_CAP) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walkDir(path.join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        if (relPath === "SKILL.md") continue;
        out.push(relPath);
        if (out.length > RESOURCE_LISTING_CAP) {
          truncated = true;
          return;
        }
      }
    }
  };
  await walkDir(rootDir, "");
  const listing = out.slice(0, RESOURCE_LISTING_CAP);
  if (truncated || out.length > RESOURCE_LISTING_CAP) {
    listing.push("(listing truncated)");
  }
  return listing;
}

// This tool runs as session code: no grant check, no OS sandbox. It must
// self-police containment — realpath both sides so symlinks can't escape
// the skill directory.
async function readBundledFile(
  skill: Skill,
  relPath: string,
): Promise<ToolResult> {
  if (path.isAbsolute(relPath)) {
    return {
      content: `read_skill: 'path' must be relative to the skill directory`,
      isError: true,
    };
  }
  const target = path.resolve(skill.rootDir, relPath);
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await fs.realpath(skill.rootDir);
    realTarget = await fs.realpath(target);
  } catch {
    return {
      content: `read_skill: '${relPath}' not found in skill '${skill.frontmatter.name}'`,
      isError: true,
    };
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    return {
      content: `read_skill: '${relPath}' is outside the skill directory`,
      isError: true,
    };
  }
  try {
    return { content: await fs.readFile(realTarget, "utf8") };
  } catch (e) {
    return {
      content: `read_skill: ${(e as Error).message}`,
      isError: true,
    };
  }
}

function declaresNewInstances(group: ToolGroup): boolean {
  return Object.values(group.tools).some(
    (entry) => typeof entry === "string" || entry.provider !== undefined,
  );
}

function renderCatalog(
  skills: readonly Skill[],
  trimmed: ReadonlyArray<{ skill: Skill; reason: string }>,
): string {
  const home = os.homedir();
  const lines: string[] = [];
  lines.push(
    "Agent Skills are available. Activate one with the read_skill tool " +
      "(pass the skill name) when a task matches its description; it " +
      "returns the skill's instructions and a listing of bundled files, " +
      "which you read with read_skill's `path` argument — load them only " +
      "as needed. Tools a skill provides are already in your tool list.",
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
