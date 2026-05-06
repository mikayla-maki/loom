/**
 * Builtin tools for runtime skill discovery + addition.
 *
 *   search_skills  — list everything addressable: providers, registry,
 *                    builtin skills.
 *   add_skill      — pull one of those into the running agent. Capabilities
 *                    that fit the existing [sandbox] ceiling expand silently;
 *                    expanding past it routes through runtime.requestPermission.
 *
 * Both are in-process (constructed by run-agent.ts) so they have privileged
 * access to the resolver chain, the LocalRegistry, and the AgentState.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { assertSubset, unionCapabilities } from "../manifest/capabilities.js";
import { parseSkillManifest, parseToolManifest } from "../manifest/parser.js";
import { LocalRegistry } from "../registry/registry.js";
import { ResolutionError } from "../errors.js";
import type {
  Provider,
  ProviderSkillResolution,
  Tool,
  ToolResult,
} from "../types/interfaces.js";
import type { Capabilities, SkillManifest, ToolManifest } from "../types/manifest.js";
import type { JSONSchema } from "../types/schema.js";
import type {
  PermissionRequest,
  PermissionResult,
} from "../types/permissions.js";

import type { AgentState } from "./agent-state.js";
import { ProcessTool } from "./tool-table.js";

export interface SkillDiscoveryDeps {
  /** Mutable state to expand on add_skill. */
  state: AgentState;
  /** Active providers — first stop in the discovery chain. */
  providers: Provider[];
  /** Local registry handle (defaults to ~/.glass). */
  registry?: LocalRegistry;
  /** Builtins root used to enumerate built-in skills. */
  builtinsDir: string;
  /** Permission gate — same handler the Runtime exposes. */
  requestPermission: (req: PermissionRequest) => Promise<PermissionResult>;
  /** Used to surface tool-introduction provenance. */
  agentName: string;
  /** PATH additions for any newly-instantiated ProcessTool. */
  pathAdditions: string[];
  /** Tool execution timeout. */
  toolTimeoutMs?: number;
  /** Resolved secrets at boot — used to merge in any newly-required ones. */
  loadedSecrets: Record<string, string>;
}

interface SkillSummary {
  name: string;
  description: string;
  source: "registry" | "builtin" | "provider";
  /** Where it lives — path or "synthetic". */
  location: string;
  /** Tools the skill brings (as known at search time). May be empty for
   *  provider skills that don't pre-enumerate. */
  tools: string[];
  /** Capability footprint (best-effort). */
  capabilities: Capabilities;
  /** Whether adding it would fit inside the agent's current ceiling. */
  fitsCeiling?: boolean;
}

const SEARCH_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Optional substring filter applied to skill name + description.",
    },
  },
};

const ADD_SCHEMA: JSONSchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: {
      type: "string",
      description:
        "The skill name to add (as returned by search_skills). Tools the skill needs are loaded with it.",
    },
    rationale: {
      type: "string",
      description:
        "Optional one-line explanation shown to the user when permission is requested.",
    },
  },
};

export class SearchSkillsTool implements Tool {
  public readonly name = "search_skills";
  public readonly description =
    "List skills available for dynamic addition (registry, builtin, or provider-supplied).";
  public readonly inputSchema = SEARCH_SCHEMA;

  constructor(private readonly deps: SkillDiscoveryDeps) {}

  async execute(input: unknown, _secrets: Record<string, string>): Promise<ToolResult> {
    const query =
      (input && typeof input === "object" && (input as { query?: unknown }).query)
        ? String((input as { query: string }).query).toLowerCase()
        : null;

    const summaries = await collectAvailableSkills(this.deps);
    const filtered = query
      ? summaries.filter(
          (s) => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query),
        )
      : summaries;
    return { content: JSON.stringify(filtered, null, 2) };
  }
}

export class AddSkillTool implements Tool {
  public readonly name = "add_skill";
  public readonly description =
    "Add a discovered skill to the running agent. Capabilities that exceed the current sandbox require user permission.";
  public readonly inputSchema = ADD_SCHEMA;

  constructor(private readonly deps: SkillDiscoveryDeps) {}

  async execute(input: unknown, _secrets: Record<string, string>): Promise<ToolResult> {
    const params = (input ?? {}) as { name?: string; rationale?: string };
    if (typeof params.name !== "string" || !params.name) {
      return { content: "add_skill: 'name' is required", isError: true };
    }
    const name = params.name;

    if (this.deps.state.hasSkill(name)) {
      return { content: `add_skill: '${name}' is already loaded.` };
    }

    let resolved: { skill: SkillManifest; tools: Array<{ manifest: ToolManifest; tool: Tool }>; secrets: string[] };
    try {
      resolved = await resolveSkillForAddition(name, this.deps);
    } catch (e) {
      return { content: `add_skill: ${(e as Error).message}`, isError: true };
    }

    const required = unionCapabilities(resolved.tools.map((t) => t.manifest.tool.capabilities));
    const ceilingBefore = this.deps.state.ceiling;

    // Check fit. If capabilities exceed the ceiling, request permission.
    let needsExpansion = false;
    try {
      assertSubset(required, ceilingBefore);
    } catch {
      needsExpansion = true;
    }

    if (needsExpansion) {
      const diff = capabilityDiff(required, ceilingBefore);
      const decision = await this.deps.requestPermission({
        kind: "expand_sandbox",
        reason:
          (params.rationale ? `${params.rationale}\n\n` : "") +
          `Add skill '${name}' which requires capabilities outside the current ceiling.`,
        newCapabilities: diff,
        currentCeiling: ceilingBefore,
        metadata: { skill: name, tools: resolved.tools.map((t) => t.manifest.tool.name) },
      });
      if (decision.decision === "deny") {
        return {
          content: `add_skill: user denied capability expansion for '${name}'. Required: ${JSON.stringify(diff)}`,
          isError: true,
        };
      }
    }

    // Resolve any newly-required secrets that weren't loaded at boot.
    const extraSecrets: Record<string, string> = {};
    for (const tool of resolved.tools) {
      for (const sname of tool.manifest.tool.secrets.required) {
        if (!(sname in this.deps.loadedSecrets) && !(sname in extraSecrets)) {
          // V0 stays simple: missing secrets surface as add_skill failure.
          // (A future iteration could open a separate permission path for
          // "the agent wants you to provide a secret value".)
          if (!process.env[sname] && !process.env[sname.toUpperCase()]) {
            return {
              content: `add_skill: '${name}' requires secret '${sname}' which is not in the agent's secret store. Add it to ~/.glass-secrets or set the env var, then retry.`,
              isError: true,
            };
          }
          extraSecrets[sname] = (process.env[sname] ?? process.env[sname.toUpperCase()]) as string;
        }
      }
    }

    const outcome = this.deps.state.addSkill({
      skill: resolved.skill,
      tools: resolved.tools.map((t) => t.tool),
      required,
      secrets: extraSecrets,
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

/**
 * Collect skill candidates from providers (via .list?()), the LocalRegistry,
 * and the builtins directory. Returns a deduped list sorted by name.
 */
async function collectAvailableSkills(deps: SkillDiscoveryDeps): Promise<SkillSummary[]> {
  const out = new Map<string, SkillSummary>();

  // 1. Providers — anything they choose to expose via list().
  for (const p of deps.providers) {
    if (!p.list) continue;
    const r = await Promise.resolve(p.list());
    for (const sk of r.skills ?? []) {
      if (!out.has(sk)) {
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
  }

  // 2. LocalRegistry — every dir under <home>/skills/ that has a SKILL.md.
  const reg = deps.registry ?? new LocalRegistry();
  await scanDir(path.join(reg.root, "skills"), out, "registry", deps);

  // 3. Builtins — same shape under builtinsDir/skills/.
  await scanDir(path.join(deps.builtinsDir, "skills"), out, "builtin", deps);

  const list = [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  // Annotate fitsCeiling for each.
  for (const s of list) {
    s.fitsCeiling = capabilityFits(s.capabilities, deps.state.ceiling);
  }
  return list;
}

async function scanDir(
  dir: string,
  out: Map<string, SkillSummary>,
  source: "registry" | "builtin",
  deps: SkillDiscoveryDeps,
): Promise<void> {
  let entries: { name: string; isDir: boolean }[] = [];
  try {
    const e = await fs.readdir(dir, { withFileTypes: true });
    entries = e.map((d) => ({ name: d.name, isDir: d.isDirectory() || d.isSymbolicLink() }));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDir) continue;
    const skillDir = path.join(dir, entry.name);
    try {
      const skill = await parseSkillManifest(skillDir);
      if (out.has(skill.name)) continue;

      // Best-effort capability rollup: parse each declared tool. Failures
      // (missing tool, etc.) just leave capabilities empty rather than
      // breaking discovery.
      const caps: Capabilities[] = [];
      const toolNames: string[] = [];
      for (const [_modelName, ref] of Object.entries(skill.requires)) {
        try {
          const toolDir = await resolveToolForListing(ref, skill.skillDir, deps);
          if (!toolDir) continue;
          const t = await parseToolManifest(toolDir);
          caps.push(t.tool.capabilities);
          toolNames.push(t.tool.name);
        } catch {
          // skip
        }
        void _modelName;
      }
      out.set(skill.name, {
        name: skill.name,
        description: skill.description,
        source,
        location: skillDir,
        tools: toolNames,
        capabilities: unionCapabilities(caps),
      });
    } catch {
      // skip non-skill directories
    }
  }
}

async function resolveToolForListing(
  ref: string,
  baseDir: string,
  deps: SkillDiscoveryDeps,
): Promise<string | null> {
  if (ref === "builtin") {
    // The builtin name = the model-facing tool name = the requires-key,
    // which we don't have here. We can't resolve cleanly without the key
    // — so treat builtin requires as opaque for listing purposes.
    return null;
  }
  if (ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("/")) {
    return path.resolve(baseDir, ref);
  }
  // For provider-claimed refs, we don't try to resolve at search time.
  return null;
}

/**
 * Resolve a skill the user just asked to add. Tries (in order):
 *   1. Each provider's resolveSkill(name) — synthetic skills with bundled tools.
 *   2. LocalRegistry agent.lookup("skill", name).
 *   3. Builtin skills directory.
 */
async function resolveSkillForAddition(
  name: string,
  deps: SkillDiscoveryDeps,
): Promise<{
  skill: SkillManifest;
  tools: Array<{ manifest: ToolManifest; tool: Tool }>;
  secrets: string[];
}> {
  // 1. Providers
  for (const p of deps.providers) {
    if (!p.resolveSkill) continue;
    const r = (await Promise.resolve(p.resolveSkill(name))) as ProviderSkillResolution | null;
    if (!r) continue;
    if (r.kind === "synthetic") {
      const tools = [...r.tools.values()];
      const secrets: string[] = [];
      for (const t of tools) for (const s of t.manifest.tool.secrets.required) secrets.push(s);
      return { skill: r.manifest, tools, secrets };
    }
    // path
    return await loadSkillFromDir(r.path, deps);
  }
  // 2. Registry
  const reg = deps.registry ?? new LocalRegistry();
  const regHit = await reg.lookup("skill", name);
  if (regHit) return await loadSkillFromDir(regHit, deps);
  // 3. Builtins
  const builtin = path.join(deps.builtinsDir, "skills", name);
  if (await fileExists(builtin)) return await loadSkillFromDir(builtin, deps);
  throw new ResolutionError(
    `skill '${name}' not found in providers, ~/.glass/skills, or builtins`,
  );
}

async function loadSkillFromDir(
  skillDir: string,
  deps: SkillDiscoveryDeps,
): Promise<{
  skill: SkillManifest;
  tools: Array<{ manifest: ToolManifest; tool: Tool }>;
  secrets: string[];
}> {
  const skill = await parseSkillManifest(skillDir);
  const tools: Array<{ manifest: ToolManifest; tool: Tool }> = [];
  const secrets: string[] = [];
  for (const [modelName, ref] of Object.entries(skill.requires)) {
    let toolDir: string;
    if (ref === "builtin" || ref.startsWith("builtin:")) {
      const bn = ref.startsWith("builtin:") ? ref.slice("builtin:".length) : modelName;
      toolDir = path.join(deps.builtinsDir, "tools", bn);
    } else if (ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("/")) {
      toolDir = path.resolve(skill.skillDir, ref);
    } else {
      // Try registry first, then builtin name.
      const reg = deps.registry ?? new LocalRegistry();
      const regHit = await reg.lookup("tool", ref);
      if (regHit) {
        toolDir = regHit;
      } else {
        toolDir = path.join(deps.builtinsDir, "tools", ref);
      }
    }
    const m = await parseToolManifest(toolDir);
    if (m.tool.name !== modelName) {
      throw new ResolutionError(
        `Skill ${skill.name} requires tool '${modelName}' but ${m.manifestPath} declares '${m.tool.name}'`,
      );
    }
    secrets.push(...m.tool.secrets.required);
    // If the new tool ships a binary, prepend its bin/ to the per-tool PATH
    // so its `invocation.command` resolves at execute time.
    const perToolExtraPath =
      m.shipsBinary && m.binDir ? [m.binDir, ...deps.pathAdditions] : deps.pathAdditions;
    const tool = new ProcessTool(m, {
      extraPath: perToolExtraPath,
      ...(deps.toolTimeoutMs ? { timeoutMs: deps.toolTimeoutMs } : {}),
    });
    tools.push({ manifest: m, tool });
  }
  return { skill, tools, secrets };
}

function capabilityDiff(required: Capabilities, ceiling: Capabilities): Capabilities {
  const out: Capabilities = {};
  for (const axis of ["filesystem", "network", "secrets"] as const) {
    const r = (required[axis] ?? []) as string[];
    const c = (ceiling[axis] ?? []) as string[];
    const cset = new Set(c);
    const missing = r.filter((x) => !cset.has(x));
    if (missing.length > 0) out[axis] = missing;
  }
  if (required.subagent && required.subagent !== "*") {
    const c = ceiling.subagent === "*" ? null : new Set(ceiling.subagent ?? []);
    if (c) {
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

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
