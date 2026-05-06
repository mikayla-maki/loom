/**
 * Manifest resolution: parse agent.toml, walk skill→tool dependencies,
 * validate against [sandbox], and produce a self-contained ResolvedAgent.
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
  SkillManifest,
  SubagentReference,
  ToolManifest,
} from "../types/manifest.js";
import type {
  Provider,
  ProviderToolResolution,
  Tool as ToolImpl,
} from "../types/interfaces.js";

/** Bare-name lookup hook (e.g. ~/.glass registry). Returns a path or null. */
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
  manifest: ToolManifest;
  /** Skill that pulled this tool in (used for v1 broker token scoping). */
  introducedBy: string;
  /** Pre-built impl from a Provider; runAgent uses it instead of ProcessTool. */
  tool?: ToolImpl;
}

export interface ResolvedSkill {
  manifest: SkillManifest;
  tools: ResolvedTool[];
  subagents: Record<string, ResolvedSubagent>;
}

export type ResolvedSubagent =
  | { kind: "path"; path: string }
  | { kind: "registry"; name: string; resolvedPath: string }
  | { kind: "inline"; manifest: AgentManifest }
  | { kind: "acp"; url: string };

export interface ResolvedAgent {
  manifest: AgentManifest;
  /** Resolved [agent].system_prompt content. */
  systemPrompt: string;
  skills: ResolvedSkill[];
  /** Flattened tools, deduped by name (last writer wins). */
  tools: ResolvedTool[];
  /** Map of secret name → tools that need it (for boot-time prompting). */
  requiredSecrets: Map<string, string[]>;
  /** PATH additions from each tool's bin/ dir. */
  pathAdditions: string[];
}

export async function resolveAgent(
  manifestPath: string,
  options: ResolveOptions = {},
): Promise<ResolvedAgent> {
  const manifest = await parseAgentManifest(manifestPath);
  const baseDir = path.dirname(manifest.manifestPath);
  const opts: ResolveOptions & { builtinsDir: string } = {
    ...options,
    builtinsDir: options.builtinsDir ?? builtinsDir(),
  };
  const providers = options.providers ?? [];

  const systemPrompt = await resolveSystemPrompt(manifest, baseDir);

  const skills: ResolvedSkill[] = [];

  // Auto-load the `core` builtin skill (bash/read_file/write_file/find)
  // unless explicitly opted out. Renders inline in the system prompt so the
  // model treats its tools as ambient capability.
  if (!manifest.agent.removeBuiltinTools) {
    const coreDir = path.join(opts.builtinsDir, "skills", "core");
    if (await isDir(coreDir)) {
      const m = await parseSkillManifest(coreDir);
      m.inlineInSystemPrompt = true;
      const tools: ResolvedTool[] = [];
      for (const [name, ref] of Object.entries(m.requires)) {
        const tm = await parseToolManifest(await resolveToolPath(ref, m.skillDir, opts, name));
        validateToolName(m.name, name, tm);
        tools.push({ manifest: tm, introducedBy: m.name });
      }
      skills.push({ manifest: m, tools, subagents: {} });
    }
  }

  for (const skillRef of Object.values(manifest.skills)) {
    const { manifest: skillManifest, providerSuppliedTools } = await loadSkill(
      skillRef,
      baseDir,
      opts,
      providers,
    );

    const skillTools: ResolvedTool[] = [];
    for (const [toolName, toolRef] of Object.entries(skillManifest.requires)) {
      const supplied = providerSuppliedTools?.get(toolName);
      if (supplied) {
        validateToolName(skillManifest.name, toolName, supplied.manifest);
        skillTools.push({
          manifest: supplied.manifest,
          introducedBy: skillManifest.name,
          tool: supplied.tool,
        });
        continue;
      }

      const fromProvider = await tryProviderTool(toolRef, providers);
      if (fromProvider) {
        const m = fromProvider.kind === "synthetic"
          ? fromProvider.manifest
          : await parseToolManifest(fromProvider.path);
        validateToolName(skillManifest.name, toolName, m);
        skillTools.push({
          manifest: m,
          introducedBy: skillManifest.name,
          ...(fromProvider.kind === "synthetic" ? { tool: fromProvider.tool } : {}),
        });
        continue;
      }

      const tm = await parseToolManifest(
        await resolveToolPath(toolRef, skillManifest.skillDir, opts, toolName),
      );
      validateToolName(skillManifest.name, toolName, tm);
      skillTools.push({ manifest: tm, introducedBy: skillManifest.name });
    }

    skills.push({
      manifest: skillManifest,
      tools: skillTools,
      subagents: await resolveSubagentReferences(skillManifest, opts),
    });
  }

  // Dedupe tools by name (last writer wins; user skills shadow core).
  const flat = new Map<string, ResolvedTool>();
  for (const sk of skills) for (const t of sk.tools) flat.set(t.manifest.tool.name, t);
  const tools = [...flat.values()];

  const required = unionCapabilities(tools.map((t) => t.manifest.tool.capabilities));
  const subagentNames = new Set<string>();
  for (const sk of skills) for (const k of Object.keys(sk.subagents)) subagentNames.add(k);
  if (subagentNames.size > 0 && required.subagent !== "*") {
    required.subagent = [...new Set([...(required.subagent ?? []), ...subagentNames])];
  }

  try {
    assertSubset(required, manifest.sandbox);
  } catch (e) {
    const coreToolNames = tools
      .filter((t) => t.introducedBy === "core")
      .map((t) => t.manifest.tool.name);
    if (coreToolNames.length > 0 && !manifest.agent.removeBuiltinTools) {
      const wrapped = new Error(
        `${(e as Error).message}\n\nHint: this includes the auto-loaded 'core' builtin skill (${coreToolNames.join(", ")}). Either widen [sandbox] to fit, or set [agent].remove_builtin_tools = true.`,
      );
      wrapped.name = (e as Error).name;
      throw wrapped;
    }
    throw e;
  }

  const requiredSecrets = new Map<string, string[]>();
  for (const t of tools) {
    for (const s of t.manifest.tool.secrets.required) {
      const arr = requiredSecrets.get(s) ?? [];
      arr.push(t.manifest.tool.name);
      requiredSecrets.set(s, arr);
    }
  }

  const pathAdditions = tools
    .filter((t) => t.manifest.shipsBinary && t.manifest.binDir)
    .map((t) => t.manifest.binDir!);

  return { manifest, systemPrompt, skills, tools, requiredSecrets, pathAdditions };
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function loadSkill(
  ref: string,
  baseDir: string,
  opts: ResolveOptions & { builtinsDir: string },
  providers: Provider[],
): Promise<{
  manifest: SkillManifest;
  providerSuppliedTools?: Map<string, { manifest: ToolManifest; tool: ToolImpl }>;
}> {
  if (!isPathLike(ref)) {
    for (const p of providers) {
      const r = await Promise.resolve(p.resolveSkill?.(ref) ?? null);
      if (!r) continue;
      if (r.kind === "synthetic") {
        return { manifest: r.manifest, providerSuppliedTools: r.tools };
      }
      return { manifest: await parseSkillManifest(r.path) };
    }
  }
  return { manifest: await parseSkillManifest(await resolveSkillPath(ref, baseDir, opts)) };
}

async function tryProviderTool(
  ref: string,
  providers: Provider[],
): Promise<ProviderToolResolution | null> {
  if (isPathLike(ref) || ref === "builtin" || ref.startsWith("builtin:")) return null;
  for (const p of providers) {
    const r = await Promise.resolve(p.resolveTool?.(ref) ?? null);
    if (r) return r;
  }
  return null;
}

function validateToolName(skill: string, expected: string, m: ToolManifest): void {
  if (m.tool.name !== expected) {
    throw new ManifestError(
      `Skill ${skill} requires tool '${expected}' but ${m.manifestPath} declares name '${m.tool.name}'`,
    );
  }
}

async function resolveSystemPrompt(
  manifest: AgentManifest,
  baseDir: string,
): Promise<string> {
  const v = manifest.agent.systemPrompt;
  if (!v) return "";
  if (!looksLikePromptPath(v)) return v;
  const p = path.resolve(baseDir, expandHome(v));
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
    throw new ResolutionError(`Skill path does not exist or is not a directory: ${p}`);
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
    throw new ResolutionError(`Tool path does not exist or is not a directory: ${p}`);
  }
  if (opts.registry) {
    const r = await opts.registry("tool", ref);
    if (r) return r;
  }
  const builtin = path.join(opts.builtinsDir, "tools", ref);
  if (await isDir(builtin)) return builtin;
  throw new ResolutionError(`Cannot resolve tool '${ref}' from ${baseDir}`);
}

async function resolveSubagentReferences(
  skill: SkillManifest,
  opts: ResolveOptions,
): Promise<Record<string, ResolvedSubagent>> {
  if (!skill.subagents) return {};
  const out: Record<string, ResolvedSubagent> = {};

  // Single __file__ entry → load a separate subagents.toml at that path.
  if (skill.subagents.__file__?.kind === "path") {
    const filePath = path.resolve(skill.skillDir, skill.subagents.__file__.path);
    const entries = await parseSubagentsFile(filePath);
    for (const [k, v] of Object.entries(entries)) {
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
      if (ref.path.startsWith("inline:")) {
        throw new ResolutionError(
          "Inline subagent manifests are not yet implemented. Use a path, registry name, or acp:// URL.",
        );
      }
      const p = path.resolve(baseDir, ref.path);
      if (!(await fileExists(p))) {
        throw new ResolutionError(`Subagent path does not exist: ${p}`);
      }
      return { kind: "path", path: p };
    }
    case "registry": {
      const hit = opts.registry ? await opts.registry("agent", ref.name) : null;
      if (!hit) throw new ResolutionError(`Cannot resolve subagent '${ref.name}' (no registry hit)`);
      return { kind: "registry", name: ref.name, resolvedPath: hit };
    }
    case "inline":
      return { kind: "inline", manifest: ref.manifest };
    case "acp":
      return { kind: "acp", url: ref.url };
  }
}

// ─── path / dir helpers ────────────────────────────────────────────────────

function isPathLike(s: string): boolean {
  return (
    s.startsWith("./") ||
    s.startsWith("../") ||
    s.startsWith("/") ||
    s.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(s)
  );
}

/** Tighter check used for [agent].system_prompt — bare strings should be inline. */
function looksLikePromptPath(s: string): boolean {
  return s.startsWith("./") || s.startsWith("../") || s.startsWith("/") || s.startsWith("~/");
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

function builtinsDir(): string {
  return findBuiltinsDir(import.meta.url);
}
