/**
 * SkillsSession — discovers Agent Skills folders (per the agentskills.io
 * spec: directories with a `SKILL.md` YAML-frontmatter + markdown file)
 * and contributes them to the agent in three ways:
 *
 *   1. System prompt section: one bullet per skill (name, path,
 *      description) so the model knows what's available.
 *   2. Trusted paths: every root advertised as read-only via
 *      `trustedPaths()`. Read-oriented tools may union with these;
 *      `bash` deliberately does not (executing scripts under a skill
 *      root still requires an explicit `[capabilities.bash]` grant).
 *   3. Required tools: aggregated from each skill's
 *      `metadata.loom.required-tools` (Loom extension under the spec's
 *      metadata point). Skills without an explicit list get the
 *      session's `default_tools` (default `["bash"]`; declaring an
 *      empty list suppresses the default). Manifest `[tools.<name>]`
 *      config + `[capabilities.<name>]` grants still own configuration.
 *
 * `prepareTurn` rescans roots each turn so mid-conversation additions
 * are picked up.
 */

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

/** Parsed `SKILL.md` frontmatter, normalised. */
export interface SkillFrontmatter {
  /** Required: short identifier (matches parent dir name per spec). */
  name: string;
  /** Required: what the skill does + when to use it. */
  description: string;
  /** Optional: license name or reference to a bundled license file. */
  license?: string;
  /** Optional: environment requirements (intended product, deps, etc.). */
  compatibility?: string;
  /** Optional: arbitrary string-keyed metadata. */
  metadata?: Record<string, string>;
  /**
   * Spec-defined: space-separated pre-approved tools. Surfaced in the
   * prompt for visibility; not yet acted on by Loom.
   */
  allowedTools?: string;
  /**
   * Loom extension: tools to register on the agent, read from
   * `metadata.loom.required-tools` (whitespace- or comma-separated
   * string). Undefined = use session `default_tools`; empty array =
   * explicitly suppress the default.
   */
  requiredTools?: string[];
}

/** A discovered skill on disk. */
export interface Skill {
  /** Absolute path to the skill's `SKILL.md`. */
  skillMdPath: string;
  /** Absolute path to the skill's containing directory. */
  rootDir: string;
  /** Parsed frontmatter. */
  frontmatter: SkillFrontmatter;
}

/** Configurable knobs for `SkillsSession`. */
export interface SkillsSessionOptions {
  /**
   * Roots to scan. Relative paths resolved against `manifestDir`; `~`
   * expands to OS home; missing roots are silently skipped.
   */
  roots: readonly string[];
  /**
   * Tools registered for skills that don't declare
   * `metadata.loom.required-tools`. Default `["bash"]`; pass `[]` to opt
   * out. A skill's explicit list (even `[]`) overrides for that skill.
   */
  defaultTools?: readonly string[];
}

export class SkillsSession implements Session {
  /** Cache populated on first read or each `prepareTurn`. */
  private cache: Skill[] | null = null;
  /** Resolved default-tools list (the option, or `["bash"]`). */
  private readonly defaultTools: readonly string[];

  constructor(private readonly options: SkillsSessionOptions) {
    this.defaultTools = options.defaultTools ?? ["bash"];
  }

  async prepareTurn(): Promise<void> {
    // Refresh each turn so newly-added skills show up.
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

  // ── helpers ──────────────────────────────────────────────────────

  private async ensureCache(): Promise<Skill[]> {
    if (!this.cache) this.cache = await scanRoots(this.options.roots);
    return this.cache;
  }

  /** Substitute `$HOME` back as `~` for nicer audit output. */
  private shortenForReason(p: string): string {
    const home = os.homedir();
    if (home && p === home) return "~";
    if (home && p.startsWith(home + path.sep)) {
      return "~" + p.slice(home.length);
    }
    return p;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Discovery.
// ──────────────────────────────────────────────────────────────────────

async function scanRoots(roots: readonly string[]): Promise<Skill[]> {
  const acc: Skill[] = [];
  for (const root of roots) {
    try {
      await walk(root, acc);
    } catch (e) {
      // Missing roots are fine (default `~/.skills` may not exist yet).
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
  }
  // Sort by name for stable prompt output.
  acc.sort((a, b) => a.frontmatter.name.localeCompare(b.frontmatter.name));
  return acc;
}

/**
 * Recurse into `dir`; any subdirectory containing `SKILL.md` is a skill
 * (don't descend into it). Skills may live at any depth, so users can
 * group them by topic.
 */
async function walk(dir: string, acc: Skill[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const hasSkillMd = entries.some((e) => e.isFile() && e.name === "SKILL.md");
  if (hasSkillMd) {
    const skillMdPath = path.join(dir, "SKILL.md");
    try {
      const fm = await readFrontmatter(skillMdPath);
      acc.push({ skillMdPath, rootDir: dir, frontmatter: fm });
    } catch {
      // Malformed skill — skip silently; boot stays resilient.
    }
    return; // don't recurse into a skill's own subdirs (scripts/, etc.)
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

// ─── Frontmatter parser ───────────────────────────────────────────────

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

  // Metadata: spec says string→string. Coerce non-strings (`version: 1.0`
  // → `"1"`) to stay lenient.
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

  // `loom.required-tools` lives under `metadata` per the spec's
  // recommendation for client-specific fields. Presence of the key
  // (even with an empty string) signals an explicit decision; absence
  // means "fall back to the session default".
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

// ─── Aggregation + rendering ─────────────────────────────────────────────

function aggregateRequiredTools(
  skills: readonly Skill[],
  defaultTools: readonly string[],
): ToolRef[] {
  // Dedupe across skills. Skills request registration only; manifest's
  // [tools.<name>] / [capabilities.<name>] still own config (runAgent's
  // dedup gives manifest refs priority on name conflicts).
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

// ─── Factory ──────────────────────────────────────────────────────────────

/** Absolute pass-through; `~` expands to OS home; relative resolves against `manifestDir`. */
function resolveRoot(raw: string, manifestDir: string): string {
  const expanded = expandHome(raw);
  if (path.isAbsolute(expanded)) return expanded;
  return path.resolve(manifestDir, expanded);
}

/**
 * Config: `root` (single) or `roots` (multiple) — default `~/.skills`.
 * `default_tools` — default `["bash"]`.
 */
export const skillsSessionFactory: SessionFactory = {
  name: "skills",
  // SkillsSession contributes a system-prompt section and tool refs
  // but doesn't override push/pull — events flow through untouched.
  // It's a pure adornment layer; chains that contain only skills (or
  // skills + compacting) need a storage layer (in-memory / file)
  // for events to actually live somewhere.
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
