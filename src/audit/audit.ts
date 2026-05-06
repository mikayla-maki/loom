/**
 * Static capability audit — walks an agent manifest + every reachable
 * subagent to compute the total declared capability surface. No LLM is
 * ever invoked.
 */

import * as path from "node:path";

import { resolveAgent, type ResolveOptions } from "../manifest/resolver.js";
import { unionCapabilities } from "../manifest/capabilities.js";
import type {
  AgentManifest,
  SandboxCeiling,
  ToolCapabilities,
} from "../types/manifest.js";

export interface CapabilityTree {
  manifestPath: string;
  name: string;
  ceiling: SandboxCeiling;
  required: SandboxCeiling;
  tools: Array<{
    name: string;
    capabilities: ToolCapabilities;
    introducedBy: string;
  }>;
  subagents: Array<{
    skill: string;
    name: string;
    kind: "path" | "registry" | "acp";
    tree?: CapabilityTree;
    note?: string;
  }>;
}

export async function auditAgent(
  source: string | AgentManifest,
  options: ResolveOptions = {},
): Promise<CapabilityTree> {
  if (typeof source === "string") {
    return await auditOne(path.resolve(source), options, new Set());
  }
  return await auditOne(source, options, new Set());
}

async function auditOne(
  source: string | AgentManifest,
  options: ResolveOptions,
  visited: Set<string>,
): Promise<CapabilityTree> {
  // Identity for cycle detection: the manifest's path on disk, or a
  // synthetic identifier for inline manifests.
  const manifestPath =
    typeof source === "string"
      ? source
      : (source.manifestPath ?? `<inline:${source.name}>`);
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

  const resolved = await resolveAgent(source, options);
  const tools = resolved.tools.map((t) => ({
    name: t.manifest.name,
    capabilities: t.manifest.capabilities ?? {},
    introducedBy: t.introducedBy,
  }));
  const required = unionCapabilities(tools.map((t) => t.capabilities));

  const subagents: CapabilityTree["subagents"] = [];
  for (const skill of resolved.skills) {
    for (const [name, ref] of Object.entries(skill.subagents)) {
      const skillName = skill.manifest.name;
      switch (ref.kind) {
        case "path":
          subagents.push({
            skill: skillName,
            name,
            kind: "path",
            tree: await auditOne(ref.path, options, visited),
          });
          break;
        case "registry":
          subagents.push({
            skill: skillName,
            name,
            kind: "registry",
            tree: await auditOne(ref.resolvedPath, options, visited),
          });
          break;
        case "acp":
          subagents.push({
            skill: skillName,
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
    name: resolved.source.name,
    ceiling: resolved.sandbox,
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
  lines.push(`${pad}  ceiling : ${formatCeiling(tree.ceiling)}`);
  lines.push(`${pad}  required: ${formatCeiling(tree.required)}`);
  if (tree.tools.length > 0) {
    lines.push(`${pad}  tools:`);
    for (const t of tree.tools) {
      lines.push(
        `${pad}    - ${t.name} (from ${t.introducedBy}): ${formatToolCaps(t.capabilities)}`,
      );
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

function formatCeiling(c: SandboxCeiling): string {
  const parts: string[] = [];
  parts.push(formatAxis("fs", c.filesystem));
  parts.push(formatAxis("net", c.network));
  parts.push(formatAxis("secrets", c.secrets));
  return parts.join(" ");
}

function formatToolCaps(c: ToolCapabilities): string {
  const parts: string[] = [];
  parts.push(formatAxis("fs", c.filesystem));
  parts.push(formatAxis("net", c.network));
  parts.push(formatAxis("secrets", c.secrets));
  if (c.subagent === "*") parts.push("subagent[*]");
  else if (Array.isArray(c.subagent) && c.subagent.length)
    parts.push(`subagent[${c.subagent.join(",")}]`);
  return parts.join(" ");
}

function formatAxis(label: string, axis: string[] | undefined): string {
  if (axis === undefined) return `${label}[*]`;
  if (axis.length === 0) return `${label}[]`;
  return `${label}[${axis.join(",")}]`;
}
