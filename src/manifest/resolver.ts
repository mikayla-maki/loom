/**
 * Manifest resolution: parse `agent.toml` (or accept an in-memory
 * `AgentManifest`), walk skill→tool dependencies, validate sandbox
 * capabilities, and produce a self-contained `ResolvedAgentManifest`.
 *
 * The input `AgentManifest` may carry unresolved references at any level:
 *   - `skills` value can be a path / registry name / inline `SkillManifest`.
 *   - A skill's `requires` can be `"builtin"` / path / registry / inline `ToolManifest`.
 *   - A skill's `subagents` can be string / `SubagentReference`.
 * The resolver dispatches at each level; nothing is "materialized" upfront.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { findBuiltinsDir } from "../runtime/builtins-dir.js";
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
  SandboxCeiling,
  SessionSpec,
  SkillManifest,
  SubagentReference,
  ToolManifest,
} from "../types/manifest.js";
import type {
  Provider,
  ProviderToolResolution,
  Tool as ToolImpl,
} from "../types/interfaces.js";

/** Bare-name lookup hook (e.g. ~/.loom registry). Returns a path or null. */
export type RegistryLookup = (
  kind: "skill" | "tool" | "agent",
  name: string,
) => string | null | Promise<string | null>;

export interface ResolveOptions {
  registry?: RegistryLookup;
  /** Override the builtins dir (used in tests). */
  builtinsDir?: string;
  /** Provider chain consulted before path / registry / builtin fallback. */
  providers?: Provider[];
}

export interface ResolvedTool {
  manifest: ToolManifest & { name: string };
  /** Skill that pulled this tool in (used for v1 broker token scoping). */
  introducedBy: string;
  /** Pre-built impl from a Provider; runAgent uses it instead of ProcessTool. */
  tool?: ToolImpl;
}

export interface ResolvedSkill {
  manifest: SkillManifest & { name: string };
  tools: ResolvedTool[];
  subagents: Record<string, ResolvedSubagent>;
}

export type ResolvedSubagent =
  | { kind: "path"; path: string }
  | { kind: "registry"; name: string; resolvedPath: string }
  | { kind: "acp"; url: string };

export interface ResolvedAgentManifest {
  /** Source manifest (may contain unresolved refs; kept for diagnostics). */
  source: AgentManifest;
  /** Resolved [agent].system_prompt content (literal text or file content). */
  systemPrompt: string;
  /** Effective sandbox after defaults applied (each axis may be undefined = unconstrained). */
  sandbox: SandboxCeiling;
  /** Effective session spec; if `source.session` was absent, this is `{ provider: "memory" }`. */
  session: SessionSpec;
  skills: ResolvedSkill[];
  /** Flattened tools, deduped by name (last writer wins). */
  tools: ResolvedTool[];
  /** Map of secret name → tools that need it (for boot-time prompting). */
  requiredSecrets: Map<string, string[]>;
  /** PATH additions from each tool's bin/ dir. */
  pathAdditions: string[];
}

const DEFAULT_SESSION = { provider: "memory" } as const;

export async function resolveAgent(
  source: string | AgentManifest,
  options: ResolveOptions = {},
): Promise<ResolvedAgentManifest> {
  const manifest =
    typeof source === "string" ? await parseAgentManifest(source) : source;

  // For inline manifests with no `manifestPath`, paths in the manifest
  // resolve relative to `process.cwd()`. For loaded manifests, relative
  // refs resolve against the manifest's directory.
  const baseDir = manifest.manifestPath
    ? path.dirname(manifest.manifestPath)
    : process.cwd();
  const opts: ResolveOptions & { builtinsDir: string } = {
    ...options,
    builtinsDir: options.builtinsDir ?? findBuiltinsDir(import.meta.url),
  };
  const providers = options.providers ?? [];

  // ─── system prompt ──────────────────────────────────────────────────────
  const systemPrompt = await resolveSystemPrompt(manifest, baseDir);

  // ─── skills + tools ─────────────────────────────────────────────────────
  const skills: ResolvedSkill[] = [];

  // Auto-load the `core` builtin skill (bash/read_file/write_file/find)
  // unless explicitly opted out. Renders inline in the system prompt.
  if (!manifest.removeBuiltinTools) {
    const coreDir = path.join(opts.builtinsDir, "skills", "core");
    if (await isDir(coreDir)) {
      const m = await parseSkillManifest(coreDir);
      m.inlineInSystemPrompt = true;
      const tools = await resolveSkillRequires(m, baseDir, opts, providers);
      skills.push({
        manifest: m as SkillManifest & { name: string },
        tools,
        subagents: {},
      });
    }
  }

  for (const [skillKey, skillRef] of Object.entries(manifest.skills ?? {})) {
    const { manifest: skillManifest, providerSuppliedTools } = await loadSkill(
      skillKey,
      skillRef,
      baseDir,
      opts,
      providers,
    );
    const tools = await resolveSkillRequires(
      skillManifest,
      baseDir,
      opts,
      providers,
      providerSuppliedTools,
    );
    skills.push({
      manifest: skillManifest as SkillManifest & { name: string },
      tools,
      subagents: await resolveSubagents(skillManifest, baseDir, opts),
    });
  }

  // Dedupe tools by name (last writer wins; user skills shadow core).
  const flat = new Map<string, ResolvedTool>();
  for (const sk of skills)
    for (const t of sk.tools) flat.set(t.manifest.name, t);
  const tools = [...flat.values()];

  // ─── sandbox check (only when sandbox was explicitly declared) ─────────
  const required = unionCapabilities(tools.map((t) => t.manifest.capabilities));
  const sandbox = manifest.sandbox ?? {};
  try {
    assertSubset(required, sandbox);
  } catch (e) {
    const coreToolNames = tools
      .filter((t) => t.introducedBy === "core")
      .map((t) => t.manifest.name);
    if (
      manifest.sandbox !== undefined &&
      coreToolNames.length > 0 &&
      !manifest.removeBuiltinTools
    ) {
      const wrapped = new Error(
        `${(e as Error).message}\n\nHint: this includes the auto-loaded 'core' builtin skill (${coreToolNames.join(", ")}). Either widen [sandbox] to fit, or set [agent].remove_builtin_tools = true.`,
      );
      wrapped.name = (e as Error).name;
      throw wrapped;
    }
    throw e;
  }

  // ─── secrets index ──────────────────────────────────────────────────────
  const requiredSecrets = new Map<string, string[]>();
  for (const t of tools) {
    for (const s of t.manifest.secrets?.required ?? []) {
      const arr = requiredSecrets.get(s) ?? [];
      arr.push(t.manifest.name);
      requiredSecrets.set(s, arr);
    }
  }

  // ─── PATH additions from each tool's bin/ dir ───────────────────────────
  const pathAdditions = tools
    .filter((t) => t.manifest.shipsBinary && t.manifest.binDir)
    .map((t) => t.manifest.binDir!);

  return {
    source: manifest,
    systemPrompt,
    sandbox,
    session: manifest.session ?? { ...DEFAULT_SESSION },
    skills,
    tools,
    requiredSecrets,
    pathAdditions,
  };
}

// ─── skill loading ─────────────────────────────────────────────────────────

async function loadSkill(
  skillKey: string,
  ref: string | SkillManifest,
  baseDir: string,
  opts: ResolveOptions & { builtinsDir: string },
  providers: Provider[],
): Promise<{
  manifest: SkillManifest;
  providerSuppliedTools?: Map<
    string,
    { manifest: ToolManifest; tool: ToolImpl }
  >;
}> {
  // Inline skill: use the spec directly. Validate + canonicalize name.
  if (typeof ref !== "string") {
    return { manifest: normalizeInlineSkill(skillKey, ref) };
  }

  // Path-like or "builtin:" → load from disk.
  if (!isPathLike(ref)) {
    for (const p of providers) {
      const r = await Promise.resolve(p.resolveSkill(ref) ?? null);
      if (!r) continue;
      if (r.kind === "synthetic") {
        return { manifest: r.manifest, providerSuppliedTools: r.tools };
      }
      return { manifest: await parseSkillManifest(r.path) };
    }
  }
  return {
    manifest: await parseSkillManifest(
      await resolveSkillPath(ref, baseDir, opts),
    ),
  };
}

function normalizeInlineSkill(
  skillKey: string,
  spec: SkillManifest,
): SkillManifest {
  if (spec.name !== undefined && spec.name !== skillKey) {
    throw new ManifestError(
      `Inline skill '${skillKey}' has name '${spec.name}'; the map key and the explicit name must agree (or omit the name).`,
    );
  }
  return { ...spec, name: skillKey, body: spec.body ?? "" };
}

// ─── tool loading ──────────────────────────────────────────────────────────

async function resolveSkillRequires(
  skill: SkillManifest,
  agentBaseDir: string,
  opts: ResolveOptions & { builtinsDir: string },
  providers: Provider[],
  providerSuppliedTools?: Map<
    string,
    { manifest: ToolManifest; tool: ToolImpl }
  >,
): Promise<ResolvedTool[]> {
  const out: ResolvedTool[] = [];
  // Tool refs in inline skills resolve relative to the agent's baseDir;
  // refs in disk-loaded skills resolve relative to the skill's dir.
  const skillBase = skill.skillDir ?? agentBaseDir;

  for (const [toolKey, toolRef] of Object.entries(skill.requires ?? {})) {
    const supplied = providerSuppliedTools?.get(toolKey);
    if (supplied) {
      const m = ensureToolName(toolKey, skill.name ?? "?", supplied.manifest);
      out.push({
        manifest: m,
        introducedBy: skill.name ?? "?",
        tool: supplied.tool,
      });
      continue;
    }

    // Inline tool spec.
    if (typeof toolRef !== "string") {
      const m = ensureToolName(toolKey, skill.name ?? "?", toolRef);
      out.push({ manifest: m, introducedBy: skill.name ?? "?" });
      continue;
    }

    // Provider-resolved bare names.
    const fromProvider = await tryProviderTool(toolRef, providers);
    if (fromProvider) {
      const rawManifest =
        fromProvider.kind === "synthetic"
          ? fromProvider.manifest
          : await parseToolManifest(fromProvider.path);
      const m = ensureToolName(toolKey, skill.name ?? "?", rawManifest);
      out.push({
        manifest: m,
        introducedBy: skill.name ?? "?",
        ...(fromProvider.kind === "synthetic"
          ? { tool: fromProvider.tool }
          : {}),
      });
      continue;
    }

    // Path / "builtin" / registry fallback.
    const tm = await parseToolManifest(
      await resolveToolPath(toolRef, skillBase, opts, toolKey),
    );
    const m = ensureToolName(toolKey, skill.name ?? "?", tm);
    out.push({ manifest: m, introducedBy: skill.name ?? "?" });
  }

  return out;
}

async function tryProviderTool(
  ref: string,
  providers: Provider[],
): Promise<ProviderToolResolution | null> {
  if (isPathLike(ref) || ref === "builtin" || ref.startsWith("builtin:"))
    return null;
  for (const p of providers) {
    const r = await Promise.resolve(p.resolveTool(ref) ?? null);
    if (r) return r;
  }
  return null;
}

/**
 * Ensure a tool manifest has a `name` field equal to the parent map key.
 * The parser fills name from `[tool].name`; inline construction may omit
 * it (the map key wins). If both are present, they must agree.
 */
function ensureToolName(
  expected: string,
  skillName: string,
  m: ToolManifest,
): ToolManifest & { name: string } {
  if (m.name !== undefined && m.name !== expected) {
    throw new ManifestError(
      `Skill ${skillName} requires tool '${expected}' but its manifest declares name '${m.name}'`,
    );
  }
  return { ...m, name: expected };
}

// ─── path resolution helpers ───────────────────────────────────────────────

async function resolveSystemPrompt(
  manifest: AgentManifest,
  baseDir: string,
): Promise<string> {
  const v = manifest.systemPrompt;
  if (v === undefined) return "";
  // Structured form: { path: "..." }.
  if (typeof v === "object") {
    const p = path.resolve(baseDir, expandHome(v.path));
    return await readSystemPromptFile(p);
  }
  // String form: prefix-based path detection (back-compat).
  if (looksLikePromptPath(v)) {
    const p = path.resolve(baseDir, expandHome(v));
    return await readSystemPromptFile(p);
  }
  return v;
}

async function readSystemPromptFile(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (e) {
    throw new ResolutionError(
      `Failed to read [agent].system_prompt file at ${p}: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

async function resolveSkillPath(
  ref: string,
  baseDir: string,
  opts: ResolveOptions & { builtinsDir: string },
): Promise<string> {
  if (isPathLike(ref)) {
    const p = path.resolve(baseDir, ref);
    if (await isDir(p)) return p;
    throw new ResolutionError(
      `Skill path does not exist or is not a directory: ${p}`,
    );
  }
  if (opts.registry) {
    const r = await opts.registry("skill", ref);
    if (r) return r;
  }
  const builtin = path.join(opts.builtinsDir, "skills", ref);
  if (await isDir(builtin)) return builtin;
  throw new ResolutionError(`Cannot resolve skill '${ref}' from ${baseDir}`);
}

async function resolveToolPath(
  ref: string,
  baseDir: string,
  opts: ResolveOptions & { builtinsDir: string },
  toolName: string,
): Promise<string> {
  if (ref === "builtin" || ref.startsWith("builtin:")) {
    const name = ref === "builtin" ? toolName : ref.slice("builtin:".length);
    const dir = path.join(opts.builtinsDir, "tools", name);
    if (await isDir(dir)) return dir;
    throw new ResolutionError(`Cannot find builtin tool '${name}' at ${dir}`);
  }
  if (isPathLike(ref)) {
    const p = path.resolve(baseDir, ref);
    if (await isDir(p)) return p;
    throw new ResolutionError(
      `Tool path does not exist or is not a directory: ${p}`,
    );
  }
  if (opts.registry) {
    const r = await opts.registry("tool", ref);
    if (r) return r;
  }
  const builtin = path.join(opts.builtinsDir, "tools", ref);
  if (await isDir(builtin)) return builtin;
  throw new ResolutionError(`Cannot resolve tool '${ref}' from ${baseDir}`);
}

// ─── subagent resolution ───────────────────────────────────────────────────

async function resolveSubagents(
  skill: SkillManifest,
  agentBaseDir: string,
  opts: ResolveOptions,
): Promise<Record<string, ResolvedSubagent>> {
  if (!skill.subagents) return {};
  const out: Record<string, ResolvedSubagent> = {};
  const baseDir = skill.skillDir ?? agentBaseDir;

  // Single __file__ entry → load a separate subagents.toml at that path.
  const fileEntry = skill.subagents.__file__;
  if (fileEntry && typeof fileEntry !== "string" && fileEntry.kind === "path") {
    const filePath = path.resolve(baseDir, fileEntry.path);
    const entries = await parseSubagentsFile(filePath);
    for (const [k, v] of Object.entries(entries)) {
      out[k] = await resolveOneSubagent(v, path.dirname(filePath), opts);
    }
    return out;
  }

  for (const [k, v] of Object.entries(skill.subagents)) {
    const ref = typeof v === "string" ? normalizeSubagentString(v) : v;
    out[k] = await resolveOneSubagent(ref, baseDir, opts);
  }
  return out;
}

function normalizeSubagentString(v: string): SubagentReference {
  if (
    v.startsWith("acp://") ||
    v.startsWith("acp+ws://") ||
    v.startsWith("acp+unix://")
  )
    return { kind: "acp", url: v };
  if (
    v.startsWith("./") ||
    v.startsWith("../") ||
    v.startsWith("/") ||
    v.endsWith(".toml")
  )
    return { kind: "path", path: v };
  return { kind: "registry", name: v };
}

async function resolveOneSubagent(
  ref: SubagentReference,
  baseDir: string,
  opts: ResolveOptions,
): Promise<ResolvedSubagent> {
  switch (ref.kind) {
    case "path": {
      const p = path.resolve(baseDir, ref.path);
      if (!(await fileExists(p))) {
        throw new ResolutionError(`Subagent path does not exist: ${p}`);
      }
      return { kind: "path", path: p };
    }
    case "registry": {
      const hit = opts.registry ? await opts.registry("agent", ref.name) : null;
      if (!hit)
        throw new ResolutionError(
          `Cannot resolve subagent '${ref.name}' (no registry hit)`,
        );
      return { kind: "registry", name: ref.name, resolvedPath: hit };
    }
    case "acp":
      return { kind: "acp", url: ref.url };
  }
}

// ─── small utilities ───────────────────────────────────────────────────────

function isPathLike(s: string): boolean {
  return (
    s.startsWith("./") ||
    s.startsWith("../") ||
    s.startsWith("/") ||
    s.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(s)
  );
}

function looksLikePromptPath(s: string): boolean {
  return (
    s.startsWith("./") ||
    s.startsWith("../") ||
    s.startsWith("/") ||
    s.startsWith("~/")
  );
}

function expandHome(s: string): string {
  return s.startsWith("~/") ? (process.env.HOME ?? "") + s.slice(1) : s;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
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
