/**
 * Static capability audit — instantiates the native provider against an
 * agent manifest and prints what it would expose. No LLM is ever invoked,
 * and no extension providers are loaded; audit is conservative and
 * deterministic. Extension-supplied tools and skills don't appear in the
 * tree (they'd require running provider init, which can have side
 * effects like opening MCP connections).
 */

import * as path from "node:path";

import { resolveSystemPrompt } from "../manifest/resolver.js";
import { getHarnessFactory, getSessionFactory } from "../extensions/index.js";
import { buildNativeProvider } from "../extensions/provider/native.js";
import { parseAgentManifest, parseSkillManifest } from "../manifest/parser.js";
import { LocalRegistry } from "../registry/registry.js";
import type {
  AgentManifest,
  SkillManifest,
  Capabilities,
} from "../types/manifest.js";
import type { Tool, ToolConfig } from "../types/interfaces.js";

export interface SecretRequest {
  name: string;
  required: boolean;
  requestedBy: string[];
}

export interface CapabilityTree {
  manifestPath: string;
  name: string;
  /** The agent's `[capabilities]` ceiling (per-tool, opaque). */
  ceiling: Capabilities;
  /**
   * Each tool the native provider could resolve, with its declared
   * capability footprint, the source that introduced it, and any
   * sub-agent trees reachable through `tool.dependencies.subagents`.
   */
  tools: Array<{
    name: string;
    capabilities: unknown;
    introducedBy: string;
    /**
     * Sub-agent trees this tool declares it may spawn. Empty when
     * the tool has no declared sub-agents. Each entry is the audit
     * tree of the corresponding `AgentManifest`, recursively.
     */
    subagents: CapabilityTree[];
  }>;
  /**
   * Every secret name a component of this agent declares it needs. Built
   * from harness + session factory `secrets` and each tool's declared
   * `secrets`. Provider-factory secrets aren't included because audit
   * doesn't load extensions — see the comment in `collectSecrets`.
   */
  secrets: SecretRequest[];
  /**
   * Sub-agent trees this manifest's session declares it may spawn
   * via `Session.dependencies.subagents`. Empty when none.
   */
  sessionSubagents: CapabilityTree[];
  /**
   * Tool refs the manifest brought in (top-level + skills) that
   * couldn't be resolved by the native provider — e.g. extension
   * tools, since audit doesn't load `[extensions]`. Useful for
   * diagnostics and for spotting gaps in sub-manifest closures.
   */
  unresolvedTools: Array<{ name: string; introducedBy: string }>;
}

const DEFAULT_TOP_LEVEL_TOOLS: Record<string, ToolConfig> = {
  bash: {},
  read_file: { paths: ["./"] },
  write_file: { paths: ["./"] },
  find: { paths: ["./"] },
};

const TOP_LEVEL = "(top-level)";

export async function auditAgent(
  source: string | AgentManifest,
): Promise<CapabilityTree> {
  return auditAgentInner(source, new Set());
}

async function auditAgentInner(
  source: string | AgentManifest,
  seenManifests: Set<string>,
): Promise<CapabilityTree> {
  const manifest =
    typeof source === "string" ? await parseAgentManifest(source) : source;
  const manifestPath =
    typeof source === "string"
      ? source
      : (source.manifestPath ?? `<inline:${source.name}>`);

  // Cycle detection. A sub-manifest that references back to one of its
  // ancestors short-circuits with an empty tree (the parent already
  // recorded its capabilities). The seen set is keyed by manifestPath
  // when available, otherwise by name.
  const cycleKey = manifest.manifestPath ?? `<inline:${manifest.name}>`;
  if (seenManifests.has(cycleKey)) {
    return {
      manifestPath,
      name: manifest.name,
      ceiling: {},
      tools: [],
      secrets: [],
      sessionSubagents: [],
      unresolvedTools: [{ name: "(cycle)", introducedBy: cycleKey }],
    };
  }
  const nextSeen = new Set(seenManifests);
  nextSeen.add(cycleKey);

  const baseDir = manifest.manifestPath
    ? path.dirname(manifest.manifestPath)
    : process.cwd();
  // Resolve system prompt for parity with runAgent (validates path-form).
  void (await resolveSystemPrompt(manifest, baseDir));

  // Walk skills the same way runAgent does (no provider init needed).
  const registry = new LocalRegistry();
  const skills: SkillManifest[] = [];
  for (const [skillKey, skillRef] of Object.entries(manifest.skills ?? {})) {
    const skill = await loadSkillForAudit(
      skillKey,
      skillRef,
      baseDir,
      registry,
    );
    skills.push(skill);
  }

  // Build the same tool-ref list runAgent builds.
  const refs: Array<{ name: string; config: ToolConfig; origin: string }> = [];
  const seen = new Map<string, string>();
  const topLevel = manifest.tools ?? DEFAULT_TOP_LEVEL_TOOLS;
  for (const [name, config] of Object.entries(topLevel)) {
    refs.push({ name, config, origin: TOP_LEVEL });
    seen.set(name, TOP_LEVEL);
  }
  for (const skill of skills) {
    for (const [name, config] of Object.entries(skill.requires ?? {})) {
      if (seen.has(name)) continue; // collisions surface in runAgent; audit is best-effort
      refs.push({ name, config, origin: skill.name ?? "(unnamed-skill)" });
      seen.set(name, skill.name ?? "(unnamed-skill)");
    }
  }

  // Run only the native provider. Extension providers stay un-audited.
  const native = buildNativeProvider();
  const tools: CapabilityTree["tools"] = [];
  const resolvedTools = new Map<string, Tool>();
  const unresolvedTools: CapabilityTree["unresolvedTools"] = [];
  for (const ref of refs) {
    const t = await Promise.resolve(native.resolveTool(ref.name, ref.config));
    if (!t) {
      unresolvedTools.push({ name: ref.name, introducedBy: ref.origin });
      continue;
    }
    resolvedTools.set(ref.name, t);
    // Recurse into the tool's declared sub-agents.
    const subagents: CapabilityTree[] = [];
    for (const sub of t.dependencies?.subagents ?? []) {
      subagents.push(await auditAgentInner(sub, nextSeen));
    }
    tools.push({
      name: ref.name,
      capabilities: t.capabilities ?? {},
      introducedBy: ref.origin,
      subagents,
    });
  }
  await native.close();

  const secrets = collectSecrets(manifest, resolvedTools);

  // Recurse into the manifest's session deps. Audit doesn't instantiate
  // sessions (factories may have side effects), but session
  // instances passed inline carry their declared `dependencies`
  // directly. For the common factory-form case this is empty; the
  // tree still reports it for parity.
  const sessionSubagents: CapabilityTree[] = [];
  if (manifest.session && !("provider" in manifest.session)) {
    const sess = manifest.session;
    for (const sub of sess.dependencies?.subagents ?? []) {
      sessionSubagents.push(await auditAgentInner(sub, nextSeen));
    }
  }

  return {
    manifestPath,
    name: manifest.name,
    ceiling: manifest.capabilities ?? {},
    tools,
    secrets,
    sessionSubagents,
    unresolvedTools,
  };
}

/**
 * Roll up every secret name a component of this agent declares.
 *
 * Sources:
 *   - harness factory's `secrets` (if `[harness]` references one by name)
 *   - session factory's `secrets`
 *   - every native-resolved tool's `secrets`
 *
 * NOT included: extension-added provider factories. Audit doesn't load
 * `[extensions]` packages.
 */
function collectSecrets(
  manifest: AgentManifest,
  tools: Map<string, Tool>,
): SecretRequest[] {
  const required = new Map<string, Set<string>>();
  const optional = new Map<string, Set<string>>();

  const addNeeds = (
    needs: { required?: string[]; optional?: string[] } | undefined,
    by: string,
  ): void => {
    if (!needs) return;
    for (const n of needs.required ?? []) {
      const arr = required.get(n) ?? new Set<string>();
      arr.add(by);
      required.set(n, arr);
    }
    for (const n of needs.optional ?? []) {
      const arr = optional.get(n) ?? new Set<string>();
      arr.add(by);
      optional.set(n, arr);
    }
  };

  if ("provider" in manifest.harness) {
    try {
      const f = getHarnessFactory(manifest.harness.provider);
      addNeeds(f.secrets, `harness:${f.name}`);
    } catch {
      /* unknown harness — skip */
    }
  }
  if (manifest.session && "provider" in manifest.session) {
    try {
      const f = getSessionFactory(manifest.session.provider);
      addNeeds(f.secrets, `session:${f.name}`);
    } catch {
      /* unknown session — skip */
    }
  }
  for (const [name, tool] of tools) {
    addNeeds(tool.secrets, `tool:${name}`);
  }

  for (const k of required.keys()) optional.delete(k);

  const out: SecretRequest[] = [];
  for (const [name, by] of required) {
    out.push({ name, required: true, requestedBy: [...by].sort() });
  }
  for (const [name, by] of optional) {
    out.push({ name, required: false, requestedBy: [...by].sort() });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function loadSkillForAudit(
  skillKey: string,
  ref: string | SkillManifest,
  baseDir: string,
  registry: LocalRegistry,
): Promise<SkillManifest> {
  if (typeof ref !== "string") {
    return { ...ref, name: skillKey, body: ref.body ?? "" };
  }
  const fs = await import("node:fs/promises");
  const isPathLike = (s: string) =>
    s.startsWith("./") ||
    s.startsWith("../") ||
    s.startsWith("/") ||
    s.startsWith("~");
  let dir: string;
  if (isPathLike(ref)) {
    dir = path.resolve(baseDir, ref);
  } else {
    const r = await registry.lookup("skill", ref);
    if (!r) {
      // Skip skills audit can't resolve (e.g. extension-supplied).
      return { name: skillKey, description: "(unresolved)", body: "" };
    }
    dir = r;
  }
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
      return { name: skillKey, description: "(unresolved)", body: "" };
    }
  } catch {
    return { name: skillKey, description: "(unresolved)", body: "" };
  }
  const skill = await parseSkillManifest(dir);
  return { ...skill, name: skillKey };
}

/** Pretty-print a CapabilityTree as a tree of strings (for CLI use). */
export function formatCapabilityTree(tree: CapabilityTree, indent = 0): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  lines.push(`${pad}${tree.name}  (${tree.manifestPath})`);
  if (Object.keys(tree.ceiling).length > 0) {
    lines.push(`${pad}  ceiling:`);
    for (const [k, v] of Object.entries(tree.ceiling)) {
      lines.push(`${pad}    - ${k}: ${JSON.stringify(v)}`);
    }
  } else {
    lines.push(`${pad}  ceiling: (none — every tool's caps stand)`);
  }
  if (tree.tools.length > 0) {
    lines.push(`${pad}  tools:`);
    for (const t of tree.tools) {
      lines.push(
        `${pad}    - ${t.name} (from ${t.introducedBy}): ${JSON.stringify(t.capabilities)}`,
      );
      for (const sub of t.subagents) {
        lines.push(`${pad}      sub-agent:`);
        lines.push(formatCapabilityTree(sub, indent + 4));
      }
    }
  }
  if (tree.unresolvedTools.length > 0) {
    lines.push(`${pad}  unresolved tools (audit doesn't load extensions):`);
    for (const u of tree.unresolvedTools) {
      lines.push(`${pad}    - ${u.name} (from ${u.introducedBy})`);
    }
  }
  if (tree.sessionSubagents.length > 0) {
    lines.push(`${pad}  session sub-agents:`);
    for (const sub of tree.sessionSubagents) {
      lines.push(formatCapabilityTree(sub, indent + 2));
    }
  }
  if (tree.secrets.length > 0) {
    lines.push(`${pad}  secrets:`);
    for (const s of tree.secrets) {
      const tag = s.required ? "required" : "optional";
      lines.push(
        `${pad}    - ${s.name} [${tag}] (needed by ${s.requestedBy.join(", ")})`,
      );
    }
  }
  return lines.join("\n");
}
