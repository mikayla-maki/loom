/**
 * Builtin tools for runtime skill discovery + addition.
 *
 *   search_skills  — list skills addressable from providers / registry / builtins
 *   add_skill      — pull one in. Capabilities that fit the agent's [sandbox]
 *                    expand silently; expansion past the ceiling routes
 *                    through runtime.requestPermission.
 *
 * Both are in-process so they can mutate AgentState directly.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { assertSubset, unionCapabilities } from "../manifest/capabilities.js";
import { parseSkillManifest, parseToolManifest } from "../manifest/parser.js";
import { LocalRegistry } from "../registry/registry.js";
import { ResolutionError } from "../errors.js";
import type {
  Provider,
  Tool,
  ToolResult,
} from "../types/interfaces.js";
import type { Capabilities, SkillManifest, ToolManifest } from "../types/manifest.js";
import type { JSONSchema } from "../types/schema.js";
import type { PermissionRequest, PermissionResult } from "../types/permissions.js";

import type { AgentState } from "./agent-state.js";
import { ProcessTool } from "./tool-table.js";

export interface SkillDiscoveryDeps {
  state: AgentState;
  providers: Provider[];
  registry?: LocalRegistry;
  builtinsDir: string;
  requestPermission: (req: PermissionRequest) => Promise<PermissionResult>;
  agentName: string;
  pathAdditions: string[];
  toolTimeoutMs?: number;
  /** Secrets resolved at agent boot. */
  loadedSecrets: Record<string, string>;
}

interface SkillSummary {
  name: string;
  description: string;
  source: "registry" | "builtin" | "provider";
  location: string;
  tools: string[];
  capabilities: Capabilities;
  fitsCeiling?: boolean;
}

interface ResolvedAddition {
  skill: SkillManifest;
  tools: Array<{ manifest: ToolManifest; tool: Tool }>;
}

const SEARCH_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Optional substring filter on name + description." },
  },
};

const ADD_SCHEMA: JSONSchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", description: "Skill name (as returned by search_skills)." },
    rationale: {
      type: "string",
      description: "Optional explanation shown to the user when permission is requested.",
    },
  },
};

export class SearchSkillsTool implements Tool {
  public readonly name = "search_skills";
  public readonly description =
    "List skills available for dynamic addition (registry, builtin, or provider-supplied).";
  public readonly inputSchema = SEARCH_SCHEMA;

  constructor(private readonly deps: SkillDiscoveryDeps) {}

  async execute(input: unknown): Promise<ToolResult> {
    const q = (input as { query?: unknown } | undefined)?.query;
    const query = typeof q === "string" && q ? q.toLowerCase() : null;
    const summaries = await collectAvailableSkills(this.deps);
    const filtered = query
      ? summaries.filter(
          (s) =>
            s.name.toLowerCase().includes(query) ||
            s.description.toLowerCase().includes(query),
        )
      : summaries;
    return { content: JSON.stringify(filtered, null, 2) };
  }
}

export class AddSkillTool implements Tool {
  public readonly name = "add_skill";
  public readonly description =
    "Add a discovered skill to the running agent. Capabilities exceeding the current sandbox require user permission.";
  public readonly inputSchema = ADD_SCHEMA;

  constructor(private readonly deps: SkillDiscoveryDeps) {}

  async execute(input: unknown): Promise<ToolResult> {
    const params = (input ?? {}) as { name?: string; rationale?: string };
    if (typeof params.name !== "string" || !params.name) {
      return { content: "add_skill: 'name' is required", isError: true };
    }
    const name = params.name;

    if (this.deps.state.hasSkill(name)) {
      return { content: `add_skill: '${name}' is already loaded.` };
    }

    let resolved: ResolvedAddition;
    try {
      resolved = await resolveSkillForAddition(name, this.deps);
    } catch (e) {
      return { content: `add_skill: ${(e as Error).message}`, isError: true };
    }

    const required = unionCapabilities(resolved.tools.map((t) => t.manifest.tool.capabilities));
    const ceiling = this.deps.state.ceiling;

    if (!capabilityFits(required, ceiling)) {
      const diff = capabilityDiff(required, ceiling);
      const decision = await this.deps.requestPermission({
        kind: "expand_sandbox",
        reason:
          (params.rationale ? `${params.rationale}\n\n` : "") +
          `Add skill '${name}' which requires capabilities outside the current ceiling.`,
        newCapabilities: diff,
        currentCeiling: ceiling,
        metadata: { skill: name, tools: resolved.tools.map((t) => t.manifest.tool.name) },
      });
      if (decision.decision === "deny") {
        return {
          content: `add_skill: user denied capability expansion for '${name}'. Required: ${JSON.stringify(diff)}`,
          isError: true,
        };
      }
    }

    const extraSecrets = collectExtraSecrets(resolved.tools, this.deps.loadedSecrets);
    if ("missing" in extraSecrets) {
      return {
        content: `add_skill: '${name}' requires secret '${extraSecrets.missing}' which is not in the agent's secret store. Add it to ~/.glass-secrets or set the env var, then retry.`,
        isError: true,
      };
    }

    const outcome = this.deps.state.addSkill({
      skill: resolved.skill,
      tools: resolved.tools.map((t) => t.tool),
      required,
      secrets: extraSecrets.secrets,
    });

    return {
      content: JSON.stringify({
        added: name,
        newTools: outcome.newTools,
        ceilingChanged: outcome.ceilingChanged,
        ceiling: outcome.ceilingAfter,
      }),
    };
  }
}

// ─── discovery ─────────────────────────────────────────────────────────────

async function collectAvailableSkills(deps: SkillDiscoveryDeps): Promise<SkillSummary[]> {
  const out = new Map<string, SkillSummary>();

  for (const p of deps.providers) {
    if (!p.list) continue;
    const r = await Promise.resolve(p.list());
    for (const sk of r.skills ?? []) {
      if (out.has(sk)) continue;
      out.set(sk, {
        name: sk,
        description: "(provider-supplied skill)",
        source: "provider",
        location: "synthetic",
        tools: [],
        capabilities: {},
      });
    }
  }

  const reg = deps.registry ?? new LocalRegistry();
  await scanSkillDir(path.join(reg.root, "skills"), out, "registry");
  await scanSkillDir(path.join(deps.builtinsDir, "skills"), out, "builtin");

  const list = [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const s of list) s.fitsCeiling = capabilityFits(s.capabilities, deps.state.ceiling);
  return list;
}

async function scanSkillDir(
  dir: string,
  out: Map<string, SkillSummary>,
  source: "registry" | "builtin",
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillDir = path.join(dir, entry.name);
    let skill: SkillManifest;
    try {
      skill = await parseSkillManifest(skillDir);
    } catch {
      continue;
    }
    if (out.has(skill.name)) continue;

    // Best-effort capability rollup: parse each declared tool. Failures
    // (missing tool, opaque builtin shorthand) just leave caps empty.
    const caps: Capabilities[] = [];
    const toolNames: string[] = [];
    for (const ref of Object.values(skill.requires)) {
      const toolDir = listingToolDir(ref, skill.skillDir);
      if (!toolDir) continue;
      try {
        const t = await parseToolManifest(toolDir);
        caps.push(t.tool.capabilities);
        toolNames.push(t.tool.name);
      } catch {
        // skip
      }
    }
    out.set(skill.name, {
      name: skill.name,
      description: skill.description,
      source,
      location: skillDir,
      tools: toolNames,
      capabilities: unionCapabilities(caps),
    });
  }
}

function listingToolDir(ref: string, baseDir: string): string | null {
  if (ref === "builtin") return null; // need the requires-key (not in scope here)
  if (ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("/")) {
    return path.resolve(baseDir, ref);
  }
  return null; // provider/registry refs need richer resolution; skip at search time
}

// ─── resolution for an actual add ──────────────────────────────────────────

async function resolveSkillForAddition(
  name: string,
  deps: SkillDiscoveryDeps,
): Promise<ResolvedAddition> {
  for (const p of deps.providers) {
    if (!p.resolveSkill) continue;
    const r = await Promise.resolve(p.resolveSkill(name));
    if (!r) continue;
    if (r.kind === "synthetic") {
      return { skill: r.manifest, tools: [...r.tools.values()] };
    }
    return await loadSkillFromDir(r.path, deps);
  }
  const reg = deps.registry ?? new LocalRegistry();
  const regHit = await reg.lookup("skill", name);
  if (regHit) return await loadSkillFromDir(regHit, deps);
  const builtin = path.join(deps.builtinsDir, "skills", name);
  if (await dirExists(builtin)) return await loadSkillFromDir(builtin, deps);
  throw new ResolutionError(
    `skill '${name}' not found in providers, ~/.glass/skills, or builtins`,
  );
}

async function loadSkillFromDir(
  skillDir: string,
  deps: SkillDiscoveryDeps,
): Promise<ResolvedAddition> {
  const skill = await parseSkillManifest(skillDir);
  const tools: ResolvedAddition["tools"] = [];
  for (const [modelName, ref] of Object.entries(skill.requires)) {
    const toolDir = await resolveToolForAddition(ref, modelName, skill.skillDir, deps);
    const m = await parseToolManifest(toolDir);
    if (m.tool.name !== modelName) {
      throw new ResolutionError(
        `Skill ${skill.name} requires tool '${modelName}' but ${m.manifestPath} declares '${m.tool.name}'`,
      );
    }
    // New tool's bin/ goes first on PATH so its invocation.command resolves.
    const extraPath =
      m.shipsBinary && m.binDir ? [m.binDir, ...deps.pathAdditions] : deps.pathAdditions;
    tools.push({
      manifest: m,
      tool: new ProcessTool(m, {
        extraPath,
        ...(deps.toolTimeoutMs ? { timeoutMs: deps.toolTimeoutMs } : {}),
      }),
    });
  }
  return { skill, tools };
}

async function resolveToolForAddition(
  ref: string,
  modelName: string,
  baseDir: string,
  deps: SkillDiscoveryDeps,
): Promise<string> {
  if (ref === "builtin" || ref.startsWith("builtin:")) {
    const name = ref === "builtin" ? modelName : ref.slice("builtin:".length);
    return path.join(deps.builtinsDir, "tools", name);
  }
  if (ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("/")) {
    return path.resolve(baseDir, ref);
  }
  const reg = deps.registry ?? new LocalRegistry();
  const regHit = await reg.lookup("tool", ref);
  return regHit ?? path.join(deps.builtinsDir, "tools", ref);
}

// ─── helpers ───────────────────────────────────────────────────────────────

function collectExtraSecrets(
  tools: Array<{ manifest: ToolManifest }>,
  loaded: Record<string, string>,
):
  | { secrets: Record<string, string> }
  | { missing: string } {
  const out: Record<string, string> = {};
  for (const t of tools) {
    for (const name of t.manifest.tool.secrets.required) {
      if (name in loaded || name in out) continue;
      const fromEnv = process.env[name] ?? process.env[name.toUpperCase()];
      if (!fromEnv) return { missing: name };
      out[name] = fromEnv;
    }
  }
  return { secrets: out };
}

function capabilityDiff(required: Capabilities, ceiling: Capabilities): Capabilities {
  const out: Capabilities = {};
  for (const axis of ["filesystem", "network", "secrets"] as const) {
    const r = (required[axis] ?? []) as string[];
    const c = new Set((ceiling[axis] ?? []) as string[]);
    const missing = r.filter((x) => !c.has(x));
    if (missing.length > 0) out[axis] = missing;
  }
  if (required.subagent && required.subagent !== "*") {
    if (ceiling.subagent !== "*") {
      const c = new Set(ceiling.subagent ?? []);
      const missing = (required.subagent as string[]).filter((x) => !c.has(x));
      if (missing.length > 0) out.subagent = missing;
    }
  } else if (required.subagent === "*" && ceiling.subagent !== "*") {
    out.subagent = "*";
  }
  return out;
}

function capabilityFits(req: Capabilities, ceiling: Capabilities): boolean {
  try {
    assertSubset(req, ceiling);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
