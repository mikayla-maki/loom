/**
 * Static capability audit — walks an agent.toml + every reachable subagent
 * to compute the total declared capability surface. No LLM is ever invoked.
 */

import * as path from "node:path";

import { resolveAgent, type ResolveOptions } from "../manifest/resolver.js";
import { unionCapabilities } from "../manifest/capabilities.js";
import type { Capabilities } from "../types/manifest.js";

export interface CapabilityTree {
  manifestPath: string;
  name: string;
  ceiling: Capabilities;
  required: Capabilities;
  tools: Array<{ name: string; capabilities: Capabilities; introducedBy: string }>;
  subagents: Array<{
    skill: string;
    name: string;
    kind: "path" | "registry" | "inline" | "acp";
    tree?: CapabilityTree;
    note?: string;
  }>;
}

export async function auditAgent(
  manifestPath: string,
  options: ResolveOptions = {},
): Promise<CapabilityTree> {
  return await auditOne(path.resolve(manifestPath), options, new Set());
}

async function auditOne(
  manifestPath: string,
  options: ResolveOptions,
  visited: Set<string>,
): Promise<CapabilityTree> {
  if (visited.has(manifestPath)) {
    return { manifestPath, name: "(cycle)", ceiling: {}, required: {}, tools: [], subagents: [] };
  }
  visited.add(manifestPath);

  const resolved = await resolveAgent(manifestPath, options);
  const tools = resolved.tools.map((t) => ({
    name: t.manifest.tool.name,
    capabilities: t.manifest.tool.capabilities,
    introducedBy: t.introducedBy,
  }));
  const required = unionCapabilities(tools.map((t) => t.capabilities));

  const subagents: CapabilityTree["subagents"] = [];
  for (const skill of resolved.skills) {
    for (const [name, ref] of Object.entries(skill.subagents)) {
      const skillName = skill.manifest.name;
      switch (ref.kind) {
        case "path":
          subagents.push({ skill: skillName, name, kind: "path", tree: await auditOne(ref.path, options, visited) });
          break;
        case "registry":
          subagents.push({ skill: skillName, name, kind: "registry", tree: await auditOne(ref.resolvedPath, options, visited) });
          break;
        case "inline":
          subagents.push({ skill: skillName, name, kind: "inline", note: "inline manifest (audit support pending)" });
          break;
        case "acp":
          subagents.push({ skill: skillName, name, kind: "acp", note: `remote: ${ref.url}` });
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
