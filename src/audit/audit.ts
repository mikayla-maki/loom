/**
 * Capability audit — walks an agent.toml plus all reachable subagents
 * (skill.subagents → recursively) and produces a tree of declared
 * capabilities. The tree is statically computable: no LLM is ever invoked.
 *
 * Use cases:
 *   - CI on agent definitions ("does this manifest exceed allowed scope?")
 *   - User-facing UI before running an agent ("here's what it can do")
 *   - Sanity-check at boot time
 */

import * as path from "node:path";

import { resolveAgent, type ResolvedAgent, type ResolveOptions } from "../manifest/resolver.js";
import { unionCapabilities } from "../manifest/capabilities.js";
import type { Capabilities } from "../types/manifest.js";

export interface CapabilityTree {
  /** Path of the agent.toml. */
  manifestPath: string;
  /** Agent name. */
  name: string;
  /** Manifest [sandbox] ceiling. */
  ceiling: Capabilities;
  /** Union of tool-required capabilities (not yet including subagents). */
  required: Capabilities;
  /** Each tool's name + capabilities. */
  tools: Array<{
    name: string;
    capabilities: Capabilities;
    introducedBy: string;
  }>;
  /** Subagents reachable from this manifest, by skill+ref-name. */
  subagents: Array<{
    skill: string;
    name: string;
    kind: "path" | "registry" | "inline" | "acp";
    /** For path/registry: a resolved CapabilityTree. */
    tree?: CapabilityTree;
    /** For acp/inline-not-supported: a brief note. */
    note?: string;
  }>;
}

/**
 * Walk an agent.toml, returning a CapabilityTree. Cycles are guarded by a
 * visited set keyed by absolute manifest path.
 */
export async function auditAgent(
  manifestPath: string,
  options: ResolveOptions = {},
): Promise<CapabilityTree> {
  const visited = new Set<string>();
  return await auditOne(path.resolve(manifestPath), options, visited);
}

async function auditOne(
  manifestPath: string,
  options: ResolveOptions,
  visited: Set<string>,
): Promise<CapabilityTree> {
  if (visited.has(manifestPath)) {
    return {
      manifestPath,
      name: "(cycle)",
      ceiling: {},
      required: {},
      tools: [],
      subagents: [],
    };
  }
  visited.add(manifestPath);

  const resolved: ResolvedAgent = await resolveAgent(manifestPath, options);
  const tools = resolved.tools.map((t) => ({
    name: t.manifest.tool.name,
    capabilities: t.manifest.tool.capabilities,
    introducedBy: t.introducedBy,
  }));
  const required = unionCapabilities(tools.map((t) => t.capabilities));

  const subagents: CapabilityTree["subagents"] = [];
  for (const skill of resolved.skills) {
    for (const [name, ref] of Object.entries(skill.subagents)) {
      switch (ref.kind) {
        case "path": {
          const tree = await auditOne(ref.path, options, visited);
          subagents.push({ skill: skill.manifest.name, name, kind: "path", tree });
          break;
        }
        case "registry": {
          const tree = await auditOne(ref.resolvedPath, options, visited);
          subagents.push({
            skill: skill.manifest.name,
            name,
            kind: "registry",
            tree,
          });
          break;
        }
        case "inline":
          subagents.push({
            skill: skill.manifest.name,
            name,
            kind: "inline",
            note: "inline manifest (audit support pending)",
          });
          break;
        case "acp":
          subagents.push({
            skill: skill.manifest.name,
            name,
            kind: "acp",
            note: `remote: ${ref.url}`,
          });
          break;
      }
    }
  }

  return {
    manifestPath,
    name: resolved.manifest.agent.name,
    ceiling: resolved.manifest.sandbox,
    required,
    tools,
    subagents,
  };
}

/** Pretty-print a CapabilityTree as a tree of strings (for CLI use). */
export function formatCapabilityTree(tree: CapabilityTree, indent = 0): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  lines.push(`${pad}${tree.name}  (${tree.manifestPath})`);
  lines.push(`${pad}  ceiling : ${formatCaps(tree.ceiling)}`);
  lines.push(`${pad}  required: ${formatCaps(tree.required)}`);
  if (tree.tools.length > 0) {
    lines.push(`${pad}  tools:`);
    for (const t of tree.tools) {
      lines.push(`${pad}    - ${t.name} (from ${t.introducedBy}): ${formatCaps(t.capabilities)}`);
    }
  }
  if (tree.subagents.length > 0) {
    lines.push(`${pad}  subagents:`);
    for (const sa of tree.subagents) {
      const tag = sa.tree ? "" : ` [${sa.kind}: ${sa.note ?? ""}]`;
      lines.push(`${pad}    - ${sa.skill}.${sa.name}${tag}`);
      if (sa.tree) lines.push(formatCapabilityTree(sa.tree, indent + 3));
    }
  }
  return lines.join("\n");
}

function formatCaps(c: Capabilities): string {
  const parts: string[] = [];
  if (c.filesystem?.length) parts.push(`fs[${c.filesystem.join(",")}]`);
  if (c.network?.length) parts.push(`net[${c.network.join(",")}]`);
  if (c.secrets?.length) parts.push(`secrets[${c.secrets.join(",")}]`);
  if (c.subagent === "*") parts.push("subagent[*]");
  else if (Array.isArray(c.subagent) && c.subagent.length) parts.push(`subagent[${c.subagent.join(",")}]`);
  return parts.length === 0 ? "(none)" : parts.join(" ");
}
