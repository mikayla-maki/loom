import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { expandHome } from "../../internal/util.js";

import YAML from "yaml";

import type {
  FactoryContext,
  Session,
  SessionFactory,
  ToolRef,
  TrustedPath,
} from "../../types/interfaces.js";
import { ManifestError } from "../../errors.js";

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
  /** Undefined = use session `default_tools`; empty array = suppress the default. */
  requiredTools?: string[];
}

export interface Skill {
  skillMdPath: string;
  rootDir: string;
  frontmatter: SkillFrontmatter;
}

export interface SkillsSessionOptions {
  roots: readonly string[];
  defaultTools?: readonly string[];
}

export class SkillsSession implements Session {
  private cache: Skill[] | null = null;
  private readonly defaultTools: readonly string[];

  constructor(private readonly options: SkillsSessionOptions) {
    this.defaultTools = options.defaultTools ?? ["bash"];
  }

  async prepareTurn(): Promise<void> {
    this.cache = await scanRoots(this.options.roots);
  }

  async systemPromptSection(): Promise<string> {
    const skills = await this.ensureCache();
    if (skills.length === 0) return "";
    return renderCatalog(skills);
  }

  async tools(): Promise<ToolRef[]> {
    const skills = await this.ensureCache();
    return aggregateRequiredTools(skills, this.defaultTools);
  }

  trustedPaths(): TrustedPath[] {
    return this.options.roots.map((root) => ({
      path: root,
      access: "read",
      reason: `Agent Skills root (${this.shortenForReason(root)})`,
    }));
  }

  private async ensureCache(): Promise<Skill[]> {
    if (!this.cache) this.cache = await scanRoots(this.options.roots);
    return this.cache;
  }

  private shortenForReason(p: string): string {
    const home = os.homedir();
    if (home && p === home) return "~";
    if (home && p.startsWith(home + path.sep)) {
      return "~" + p.slice(home.length);
    }
    return p;
  }
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
    const skillMdPath = path.join(dir, "SKILL.md");
    try {
      const fm = await readFrontmatter(skillMdPath);
      acc.push({ skillMdPath, rootDir: dir, frontmatter: fm });
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

async function readFrontmatter(skillMdPath: string): Promise<SkillFrontmatter> {
  const text = await fs.readFile(skillMdPath, "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    throw new Error(`SKILL.md has no YAML frontmatter: ${skillMdPath}`);
  }
  return parseFrontmatter(match[1] ?? "");
}

const REQUIRED_TOOLS_KEY = "loom.required-tools";

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

  let metadata: Record<string, string> | undefined;
  if (
    obj.metadata &&
    typeof obj.metadata === "object" &&
    !Array.isArray(obj.metadata)
  ) {
    metadata = {};
    for (const [k, v] of Object.entries(obj.metadata)) {
      metadata[k] = stringify(v);
    }
    fm.metadata = metadata;
  }

  if (metadata && Object.hasOwn(metadata, REQUIRED_TOOLS_KEY)) {
    fm.requiredTools = toStringList(metadata[REQUIRED_TOOLS_KEY]);
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

function toStringList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) {
    return v.map((x) => stringify(x)).filter((s) => s.length > 0);
  }
  if (typeof v === "string") {
    return v.split(/[,\s]+/g).filter((s) => s.length > 0);
  }
  return [];
}

function aggregateRequiredTools(
  skills: readonly Skill[],
  defaultTools: readonly string[],
): ToolRef[] {
  const seen = new Set<string>();
  const out: ToolRef[] = [];
  const add = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, config: {} });
  };
  for (const skill of skills) {
    const list = skill.frontmatter.requiredTools ?? defaultTools;
    for (const name of list) add(name);
  }
  return out;
}

function renderCatalog(skills: readonly Skill[]): string {
  const home = os.homedir();
  const lines: string[] = [];
  lines.push(
    "Agent Skills are available. Each is a folder containing SKILL.md " +
      "(metadata + instructions) plus optional scripts/, references/, " +
      "and assets/. To activate a skill, read its SKILL.md with the " +
      "file tool; load referenced files only as needed.",
  );
  lines.push("");
  for (const skill of skills) {
    const fm = skill.frontmatter;
    const display = displayPath(skill.skillMdPath, home);
    lines.push(`- **${fm.name}** (\`${display}\`) — ${fm.description}`);
    const extras: string[] = [];
    if (fm.compatibility) extras.push(`compatibility: ${fm.compatibility}`);
    if (fm.allowedTools) extras.push(`pre-approved tools: ${fm.allowedTools}`);
    if (fm.requiredTools && fm.requiredTools.length > 0) {
      extras.push(`requires tools: ${fm.requiredTools.join(", ")}`);
    }
    for (const e of extras) lines.push(`  - ${e}`);
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

export const skillsSessionFactory: SessionFactory = {
  name: "skills",
  passThrough: true,
  create(config: Record<string, unknown>, ctx: FactoryContext): Session {
    const rawRoots = collectRoots(config);
    const roots = rawRoots.map((r) => resolveRoot(r, ctx.manifestDir));
    const defaultTools = collectDefaultTools(config);
    return new SkillsSession({ roots, defaultTools });
  },
};

function collectDefaultTools(
  config: Record<string, unknown>,
): readonly string[] | undefined {
  if (config.default_tools === undefined) return undefined;
  if (
    !Array.isArray(config.default_tools) ||
    !config.default_tools.every((s) => typeof s === "string")
  ) {
    throw new ManifestError(
      `[session] provider 'skills' config 'default_tools' must be an array of strings`,
    );
  }
  return config.default_tools as string[];
}

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
