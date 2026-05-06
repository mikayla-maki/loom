/**
 * Static capability audit — walks an agent manifest + every reachable
 * subagent to compute the total declared capability surface. No LLM is
 * ever invoked.
 */

import * as path from "node:path";

import { resolveAgent, type ResolveOptions } from "../manifest/resolver.js";
import { unionCapabilities } from "../manifest/capabilities.js";
import { getHarnessFactory, getSessionFactory } from "../extensions/index.js";
import type {
  AgentManifest,
  SandboxCeiling,
  ToolCapabilities,
} from "../types/manifest.js";

/**
 * One declared secret name plus a human-readable list of who asked for
 * it (`harness:anthropic`, `tool:bash`, etc.) and whether any requester
 * marked it required.
 */
export interface SecretRequest {
  name: string;
  required: boolean;
  requestedBy: string[];
}

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
  /**
   * Every secret name a component of this agent declares it needs. Built
   * from harness + session factory `secrets` and each tool's
   * `[tool.secrets]`. Provider-factory secrets aren't included because
   * audit doesn't load extensions — see the comment in `collectSecrets`.
   */
  secrets: SecretRequest[];
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
      secrets: [],
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
  const secrets = collectSecrets(resolved.source, resolved.tools);

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
    secrets,
    subagents,
  };
}

/**
 * Roll up every secret name a component of this agent declares.
 *
 * Sources:
 *   - harness factory's `secrets` (if `[harness]` references one by name)
 *   - session factory's `secrets`
 *   - every resolved tool's `[tool.secrets]`
 *
 * NOT included: extension-added provider factories. Audit doesn't load
 * `[extensions]` packages — that's a side-effect surface and would
 * make audit dynamic. The result is that an `audit` of a manifest
 * with `[extensions.foo-mcp]` won't show foo-mcp's required tokens.
 * `loom run` will still resolve them; `loom audit` is conservative.
 */
function collectSecrets(
  manifest: AgentManifest,
  tools: import("../manifest/resolver.js").ResolvedTool[],
): SecretRequest[] {
  const required = new Map<string, Set<string>>(); // name → requesters
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

  // Harness
  if ("provider" in manifest.harness) {
    try {
      const f = getHarnessFactory(manifest.harness.provider);
      addNeeds(f.secrets, `harness:${f.name}`);
    } catch {
      // Unknown harness provider — skip; resolveAgent already validated
      // it for the run path. Audit shouldn't fail just because a
      // hypothetical extension isn't loaded yet.
    }
  }

  // Session
  if (manifest.session && "provider" in manifest.session) {
    try {
      const f = getSessionFactory(manifest.session.provider);
      addNeeds(f.secrets, `session:${f.name}`);
    } catch {
      // ditto
    }
  }

  // Tools
  for (const t of tools) {
    addNeeds(t.manifest.secrets, `tool:${t.manifest.name}`);
  }

  // Required wins on conflict.
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
  if (tree.secrets.length > 0) {
    lines.push(`${pad}  secrets:`);
    for (const s of tree.secrets) {
      const tag = s.required ? "required" : "optional";
      lines.push(
        `${pad}    - ${s.name} [${tag}] (needed by ${s.requestedBy.join(", ")})`,
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
