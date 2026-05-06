/**
 * Manifest resolution.
 *
 * Given an `agent.toml` path, walk the skill→tool dependency graph, locate
 * builtins / registry entries / local paths, validate capability ceilings,
 * and produce a self-contained `ResolvedAgent` ready to run.
 */

import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
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
  // node:fs's existsSync is the simplest way to do a sync existence check;
  // we need it sync because builtinsDir() walks the directory tree at
  // module load time and needs to return synchronously.
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/** A registry resolver function, e.g. `~/.glass` lookup. May return null. */
export type RegistryLookup = (kind: "skill" | "tool" | "agent", name: string) =>
  | string
  | null
  | Promise<string | null>;

import type {
  Provider,
  ProviderSkillResolution,
  ProviderToolResolution,
  Tool as ToolImpl,
} from "../types/interfaces.js";

export interface ResolveOptions {
  /** Optional registry lookup; bare names try this before failing. */
  registry?: RegistryLookup;
  /** Override builtins directory (used by tests). */
  builtinsDir?: string;
  /**
   * Pluggable resolver chain. Each Provider may claim a tool or skill name
   * before the resolver falls back to local path / registry / builtin. This
   * is the extension point an MCP-style extension would implement to expose
   * MCP-server tools as Glass tools.
   */
  providers?: Provider[];
}

export interface ResolvedTool {
  manifest: ToolManifest;
  /** The skill that pulled this tool in (used for v1 broker token scoping). */
  introducedBy: string;
  /**
   * Pre-built Tool implementation, supplied by a Provider. When present,
   * runAgent uses this instead of constructing a ProcessTool. This is how
   * non-process tools (MCP servers, HTTP-backed tools, etc.) plug in.
   */
  tool?: ToolImpl;
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
  /** The resolved system-prompt-core string — the literal value the runtime
   *  will splice into the assembled system prompt as the agent's identity. */
  systemPrompt: string;
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

  // Resolve the manifest's system_prompt content (path or inline).
  const systemPrompt = await resolveSystemPrompt(manifest, baseDir);

  const providers = options.providers ?? [];

  // Resolve each skill. The auto-loaded `core` builtin (if not opted out)
  // is always first so its tools are always available; subsequent skills
  // can introduce more, but a manifest skill that names the same tools
  // would collide with these (the resolver dedupes by tool name and last
  // writer wins, so user-defined shadows are explicit).
  const skills: ResolvedSkill[] = [];
  if (!manifest.agent.removeBuiltinTools) {
    const coreDir = path.join(opts.builtinsDir ?? builtinsDir(), "skills", "core");
    if (await isDir(coreDir)) {
      const coreManifest = await parseSkillManifest(coreDir);
      // Mark the core skill so the runtime renders its body inline rather
      // than under '# Available Skills'.
      coreManifest.inlineInSystemPrompt = true;
      const coreTools: ResolvedTool[] = [];
      for (const [toolModelName, toolRef] of Object.entries(coreManifest.requires)) {
        const toolDir = await resolveToolPath(
          toolRef,
          coreManifest.skillDir,
          opts,
          toolModelName,
        );
        const toolManifest = await parseToolManifest(toolDir);
        validateToolName(coreManifest.name, toolModelName, toolManifest);
        coreTools.push({ manifest: toolManifest, introducedBy: coreManifest.name });
      }
      skills.push({ manifest: coreManifest, tools: coreTools, subagents: {} });
    }
  }
  for (const [skillName, skillRef] of Object.entries(manifest.skills)) {
    let skillManifest: SkillManifest;
    let providerSuppliedTools: Map<string, { manifest: ToolManifest; tool: ToolImpl }> | undefined;

    // 1. Provider chain claims this skill name (only for non-path-like refs).
    if (!isPathLike(skillRef)) {
      const claim = await firstNonNull(providers, (p) =>
        p.resolveSkill ? Promise.resolve(p.resolveSkill(skillRef)) : Promise.resolve(null),
      );
      if (claim) {
        if (claim.kind === "synthetic") {
          skillManifest = claim.manifest;
          providerSuppliedTools = claim.tools;
        } else {
          skillManifest = await parseSkillManifest(claim.path);
        }
      } else {
        const skillDir = await resolveSkillPath(skillRef, baseDir, opts);
        skillManifest = await parseSkillManifest(skillDir);
      }
    } else {
      const skillDir = await resolveSkillPath(skillRef, baseDir, opts);
      skillManifest = await parseSkillManifest(skillDir);
    }

    void skillName; // skill key is informational; the skill's own name is canonical

    const skillTools: ResolvedTool[] = [];
    for (const [toolModelName, toolRef] of Object.entries(skillManifest.requires)) {
      // 1. Tool came pre-built with the synthetic skill.
      const supplied = providerSuppliedTools?.get(toolModelName);
      if (supplied) {
        validateToolName(skillManifest.name, toolModelName, supplied.manifest);
        skillTools.push({
          manifest: supplied.manifest,
          introducedBy: skillManifest.name,
          tool: supplied.tool,
        });
        continue;
      }

      // 2. Provider chain claims this tool by reference name (non-path-like).
      let providerTool: ProviderToolResolution | null = null;
      if (!isPathLike(toolRef) && toolRef !== "builtin" && !toolRef.startsWith("builtin:")) {
        providerTool = await firstNonNull(providers, (p) =>
          p.resolveTool ? Promise.resolve(p.resolveTool(toolRef)) : Promise.resolve(null),
        );
      }
      if (providerTool) {
        if (providerTool.kind === "synthetic") {
          validateToolName(skillManifest.name, toolModelName, providerTool.manifest);
          skillTools.push({
            manifest: providerTool.manifest,
            introducedBy: skillManifest.name,
            tool: providerTool.tool,
          });
          continue;
        } else {
          const toolManifest = await parseToolManifest(providerTool.path);
          validateToolName(skillManifest.name, toolModelName, toolManifest);
          skillTools.push({ manifest: toolManifest, introducedBy: skillManifest.name });
          continue;
        }
      }

      // 3. Path / registry / builtin (existing behaviour).
      const toolDir = await resolveToolPath(toolRef, skillManifest.skillDir, opts, toolModelName);
      const toolManifest = await parseToolManifest(toolDir);
      validateToolName(skillManifest.name, toolModelName, toolManifest);
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

  // Validate capabilities. If the failure involves a tool introduced by the
  // auto-loaded `core` skill, surface a hint about the opt-out flag.
  const required = unionCapabilities(tools.map((t) => t.manifest.tool.capabilities));
  const coreTools = new Set(
    tools.filter((t) => t.introducedBy === "core").map((t) => t.manifest.tool.name),
  );
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
  try {
    assertSubset(required, manifest.sandbox);
  } catch (e) {
    if (coreTools.size > 0 && !manifest.agent.removeBuiltinTools) {
      const original = (e as Error).message;
      const wrapped = new Error(
        `${original}\n\nHint: this includes capabilities required by the auto-loaded 'core' builtin skill (${[...coreTools].join(", ")}). Either widen [sandbox] to fit, or set [agent].remove_builtin_tools = true.`,
      );
      wrapped.name = (e as Error).name;
      throw wrapped;
    }
    throw e;
  }

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
    systemPrompt,
    skills,
    tools,
    requiredSecrets,
    pathAdditions,
  };
}

function validateToolName(skillName: string, expected: string, m: ToolManifest): void {
  if (m.tool.name !== expected) {
    throw new ManifestError(
      `Skill ${skillName} requires tool '${expected}' but ${m.manifestPath} declares name '${m.tool.name}'`,
    );
  }
}

async function firstNonNull<T extends object, R>(
  arr: T[],
  fn: (t: T) => Promise<R | null | undefined>,
): Promise<R | null> {
  for (const item of arr) {
    const v = await fn(item);
    if (v !== null && v !== undefined) return v as R;
  }
  return null;
}

async function resolveSystemPrompt(
  manifest: AgentManifest,
  baseDir: string,
): Promise<string> {
  const v = manifest.agent.systemPrompt;
  if (v === undefined || v === "") return "";
  if (looksLikePath(v)) {
    const p = path.resolve(baseDir.replace(/^~(?=\/)/, process.env.HOME ?? "~"), expandHome(v));
    try {
      return await fs.readFile(p, "utf8");
    } catch (e) {
      throw new ResolutionError(
        `Failed to read [agent].system_prompt file at ${p}: ${(e as Error).message}`,
        { cause: e },
      );
    }
  }
  // Inline literal — used verbatim. (TOML triple-quoted multiline strings
  // also flow through here naturally.)
  return v;
}

/**
 * Heuristic: a `[agent].system_prompt` value is treated as a path iff it
 * starts with `./`, `../`, `/`, or `~/`. Bare strings (no path prefix) are
 * treated as inline content. This matches how the rest of the resolver
 * decides path-vs-name for skills and tools.
 */
function looksLikePath(s: string): boolean {
  return s.startsWith("./") || s.startsWith("../") || s.startsWith("/") || s.startsWith("~/");
}

function expandHome(s: string): string {
  if (s.startsWith("~/")) {
    const home = process.env.HOME ?? "";
    return home + s.slice(1);
  }
  return s;
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
