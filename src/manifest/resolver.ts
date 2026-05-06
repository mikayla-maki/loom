/**
 * Manifest resolution.
 *
 * Given an `agent.toml` path, walk the skill→tool dependency graph, locate
 * builtins / registry entries / local paths, validate capability ceilings,
 * and produce a self-contained `ResolvedAgent` ready to run.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { ManifestError, ResolutionError } from "../errors.js";
import { assertSubset, unionCapabilities } from "./capabilities.js";
import {
  parseAgentManifest,
  parseSkillManifest,
  parseSubagentsFile,
  parseToolManifest,
} from "./parser.js";
import type {
  AgentManifest,
  SkillManifest,
  SubagentReference,
  ToolManifest,
} from "../types/manifest.js";

/** Directory that ships builtin skills/tools (relative to compiled lib). */
function builtinsDir(): string {
  // We expect builtins to live under: <pkg-root>/src/builtins (dev) or
  // <pkg-root>/dist/builtins (built). Since builtins are static files we
  // ship them under src/ and resolve from this module's location.
  // import.meta.url is the URL of the compiled file at runtime.
  const here = fileURLToPath(import.meta.url);
  // here = .../dist/manifest/resolver.js (or .../src/manifest/resolver.ts under tsx)
  // builtins live at <pkg-root>/builtins/{tools,skills}
  let dir = path.dirname(here);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "builtins");
    if (existsSyncSafe(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  // Fall back to checking sibling 'builtins' next to dist/src.
  return path.join(path.dirname(path.dirname(here)), "builtins");
}

function existsSyncSafe(p: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sync = require("node:fs") as typeof import("node:fs");
    return sync.existsSync(p);
  } catch {
    return false;
  }
}

/** A registry resolver function, e.g. `~/.glass` lookup. May return null. */
export type RegistryLookup = (kind: "skill" | "tool" | "agent", name: string) =>
  | string
  | null
  | Promise<string | null>;

export interface ResolveOptions {
  /** Optional registry lookup; bare names try this before failing. */
  registry?: RegistryLookup;
  /** Override builtins directory (used by tests). */
  builtinsDir?: string;
}

export interface ResolvedTool {
  manifest: ToolManifest;
  /** The skill that pulled this tool in (used for v1 broker token scoping). */
  introducedBy: string;
}

export interface ResolvedSkill {
  manifest: SkillManifest;
  /** Resolved tool dependencies (in the order requires{} declared them). */
  tools: ResolvedTool[];
  /** Resolved subagent references (paths only — not yet booted). */
  subagents: Record<string, ResolvedSubagent>;
}

export type ResolvedSubagent =
  | { kind: "path"; path: string }
  | { kind: "registry"; name: string; resolvedPath: string }
  | { kind: "inline"; manifest: AgentManifest }
  | { kind: "acp"; url: string };

export interface ResolvedAgent {
  manifest: AgentManifest;
  identity: string;
  skills: ResolvedSkill[];
  /** All tools, flattened, deduped by name (last writer wins). */
  tools: ResolvedTool[];
  /** Map of secret name → required-by tools (for prompting). */
  requiredSecrets: Map<string, string[]>;
  /** PATH additions (each tool's bin/ dir if it ships one). */
  pathAdditions: string[];
}

/** Walk an `agent.toml` into a fully-resolved structure. */
export async function resolveAgent(
  manifestPath: string,
  options: ResolveOptions = {},
): Promise<ResolvedAgent> {
  const manifest = await parseAgentManifest(manifestPath);
  const baseDir = path.dirname(manifest.manifestPath);
  const opts: Required<Pick<ResolveOptions, "builtinsDir">> & ResolveOptions = {
    builtinsDir: options.builtinsDir ?? builtinsDir(),
    ...(options.registry ? { registry: options.registry } : {}),
  };

  // Resolve identity content.
  const identity = await resolveIdentity(manifest, baseDir);

  // Resolve each skill.
  const skills: ResolvedSkill[] = [];
  for (const [skillName, skillRef] of Object.entries(manifest.skills)) {
    const skillDir = await resolveSkillPath(skillRef, baseDir, opts);
    const skillManifest = await parseSkillManifest(skillDir);
    if (skillManifest.name !== skillName) {
      // Soft warning shape: allow rename but expose under manifest key.
      // We use the skill's manifest name as canonical.
    }
    const skillTools: ResolvedTool[] = [];
    for (const [toolModelName, toolRef] of Object.entries(skillManifest.requires)) {
      const toolDir = await resolveToolPath(toolRef, skillManifest.skillDir, opts, toolModelName);
      const toolManifest = await parseToolManifest(toolDir);
      // The model-facing name in the skill MUST equal the tool's declared name.
      if (toolManifest.tool.name !== toolModelName) {
        throw new ManifestError(
          `Skill ${skillManifest.name} requires tool '${toolModelName}' but ${toolManifest.manifestPath} declares name '${toolManifest.tool.name}'`,
        );
      }
      skillTools.push({ manifest: toolManifest, introducedBy: skillManifest.name });
    }

    // Resolve subagents (paths/inline/registry/acp). Recursion happens at
    // call time; we just stash the references here.
    const resolvedSubagents = await resolveSubagentReferences(skillManifest, opts);

    skills.push({ manifest: skillManifest, tools: skillTools, subagents: resolvedSubagents });
  }

  // Flatten tools (dedupe by tool.name; later wins, but warn on conflict).
  const flat = new Map<string, ResolvedTool>();
  for (const sk of skills) {
    for (const t of sk.tools) {
      flat.set(t.manifest.tool.name, t);
    }
  }
  const tools = Array.from(flat.values());

  // Validate capabilities.
  const required = unionCapabilities(tools.map((t) => t.manifest.tool.capabilities));
  // Subagents declared by skills bubble into required.subagent.
  const subagentNames = new Set<string>();
  for (const sk of skills) {
    for (const k of Object.keys(sk.subagents)) subagentNames.add(k);
  }
  if (subagentNames.size > 0) {
    const cur = required.subagent;
    if (cur === "*") {
      // already wide-open
    } else {
      required.subagent = Array.from(new Set([...(cur ?? []), ...subagentNames]));
    }
  }
  assertSubset(required, manifest.sandbox);

  // Required secrets.
  const requiredSecrets = new Map<string, string[]>();
  for (const t of tools) {
    for (const s of t.manifest.tool.secrets.required) {
      const arr = requiredSecrets.get(s) ?? [];
      arr.push(t.manifest.tool.name);
      requiredSecrets.set(s, arr);
    }
  }

  // PATH additions.
  const pathAdditions: string[] = [];
  for (const t of tools) {
    if (t.manifest.shipsBinary && t.manifest.binDir) {
      pathAdditions.push(t.manifest.binDir);
    }
  }

  return {
    manifest,
    identity,
    skills,
    tools,
    requiredSecrets,
    pathAdditions,
  };
}

async function resolveIdentity(manifest: AgentManifest, baseDir: string): Promise<string> {
  if (manifest.agent.identityInline !== undefined) {
    return manifest.agent.identityInline;
  }
  if (manifest.agent.identity !== undefined) {
    const p = path.resolve(baseDir, manifest.agent.identity);
    try {
      return await fs.readFile(p, "utf8");
    } catch (e) {
      throw new ResolutionError(
        `Failed to read [agent].identity file at ${p}: ${(e as Error).message}`,
        { cause: e },
      );
    }
  }
  return "";
}

async function resolveSkillPath(
  ref: string,
  baseDir: string,
  opts: ResolveOptions,
): Promise<string> {
  // 1) explicit path (./, ../, /)
  if (isPathLike(ref)) {
    const p = path.resolve(baseDir, ref);
    if (await isDir(p)) return p;
    throw new ResolutionError(`Skill path does not exist or is not a directory: ${p}`);
  }
  // 2) registry lookup
  if (opts.registry) {
    const r = await opts.registry("skill", ref);
    if (r) return r;
  }
  // 3) builtin skills/<name>
  const builtin = path.join(opts.builtinsDir ?? builtinsDir(), "skills", ref);
  if (await isDir(builtin)) return builtin;
  throw new ResolutionError(`Cannot resolve skill '${ref}' from ${baseDir}`);
}

async function resolveToolPath(
  ref: string,
  baseDir: string,
  opts: ResolveOptions,
  toolModelName: string,
): Promise<string> {
  if (ref === "builtin" || ref.startsWith("builtin:")) {
    const name = ref.startsWith("builtin:") ? ref.slice("builtin:".length) : toolModelName;
    const dir = path.join(opts.builtinsDir ?? builtinsDir(), "tools", name);
    if (await isDir(dir)) return dir;
    throw new ResolutionError(`Cannot find builtin tool '${name}' at ${dir}`);
  }
  if (isPathLike(ref)) {
    const p = path.resolve(baseDir, ref);
    if (await isDir(p)) return p;
    throw new ResolutionError(`Tool path does not exist or is not a directory: ${p}`);
  }
  if (opts.registry) {
    const r = await opts.registry("tool", ref);
    if (r) return r;
  }
  const builtin = path.join(opts.builtinsDir ?? builtinsDir(), "tools", ref);
  if (await isDir(builtin)) return builtin;
  throw new ResolutionError(`Cannot resolve tool '${ref}' from ${baseDir}`);
}

/**
 * The skill-loading pipeline calls into the tool resolver with the value of
 * SKILL.md `requires`'s value as `ref`. To support the bare `"builtin"`
 * shorthand from the spec, we override resolveToolPath here in resolveAgent
 * via a small wrapper — but for cleanliness we handle it inline by inspecting
 * `requires` keys.
 */
async function isDir(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

function isPathLike(s: string): boolean {
  return (
    s.startsWith("./") ||
    s.startsWith("../") ||
    s.startsWith("/") ||
    s.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(s) // windows
  );
}

// Subagent reference resolution (does NOT recurse — just locates manifests).
async function resolveSubagentReferences(
  skill: SkillManifest,
  opts: ResolveOptions,
): Promise<Record<string, ResolvedSubagent>> {
  if (!skill.subagents) return {};
  const out: Record<string, ResolvedSubagent> = {};

  // Special: skill.subagents may have a single __file__ entry meaning "load
  // a subagents.toml file at this path".
  if (skill.subagents.__file__ && skill.subagents.__file__.kind === "path") {
    const filePath = path.resolve(skill.skillDir, skill.subagents.__file__.path);
    const fileEntries = await parseSubagentsFile(filePath);
    for (const [k, v] of Object.entries(fileEntries)) {
      out[k] = await resolveSingleSubagent(v, path.dirname(filePath), opts);
    }
    return out;
  }

  for (const [k, v] of Object.entries(skill.subagents)) {
    out[k] = await resolveSingleSubagent(v, skill.skillDir, opts);
  }
  return out;
}

async function resolveSingleSubagent(
  ref: SubagentReference,
  baseDir: string,
  opts: ResolveOptions,
): Promise<ResolvedSubagent> {
  switch (ref.kind) {
    case "path": {
      // Special-case: "inline:..." encoded path means actual inline TOML.
      if (ref.path.startsWith("inline:")) {
        const tomlText = ref.path.slice("inline:".length);
        // We can't parse a full agent.toml from a string without a path. For
        // now, throw — true inline support is a v1.x nicety and can be
        // implemented by writing to a temp file. (Most use-cases are path
        // / name / acp.)
        throw new ResolutionError(
          `Inline subagent manifests are not yet implemented. Use a path or registry name instead. (preview: ${tomlText.slice(0, 40)}...)`,
        );
      }
      const p = path.resolve(baseDir, ref.path);
      if (!(await fileExists(p))) {
        throw new ResolutionError(`Subagent path does not exist: ${p}`);
      }
      return { kind: "path", path: p };
    }
    case "registry": {
      if (opts.registry) {
        const r = await opts.registry("agent", ref.name);
        if (r) return { kind: "registry", name: ref.name, resolvedPath: r };
      }
      throw new ResolutionError(`Cannot resolve subagent '${ref.name}' (no registry hit)`);
    }
    case "inline":
      return { kind: "inline", manifest: ref.manifest };
    case "acp":
      return { kind: "acp", url: ref.url };
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Override the bare "builtin" requires shorthand.
//
// SKILL.md may say `requires: { secrets.get: builtin }`. The resolver needs
// to know the model-facing tool name to find the builtin. We patch in this
// behavior by overriding resolveToolPath through the calling code in
// resolveAgent: instead of calling resolveToolPath(ref) directly, we
// call a wrapper that, if ref === 'builtin', delegates to
// resolveBuiltinByName(toolModelName).
// ──────────────────────────────────────────────────────────────────────────────

// (Implemented above by callers passing toolModelName when ref === 'builtin'.)
