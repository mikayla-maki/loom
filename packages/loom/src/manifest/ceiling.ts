export {
  DEFAULT_TOP_LEVEL_CAPABILITIES,
  ceilingFor,
} from "@mcmaki/loom-capabilities";

import { ceilingFor, effectiveCeiling } from "@mcmaki/loom-capabilities";
import { buildNativeTools } from "../builtins/tools/native.js";
import { CapabilityError } from "../errors.js";
import type { Agent } from "../types/interfaces.js";
import type {
  AgentManifest,
  Capabilities,
  ToolEntry,
  ToolGroup,
  ToolGroupVerdict,
} from "../types/manifest.js";
import { containsWithTool } from "./capabilities.js";
import { DEFAULT_BUILTIN_TOOLS } from "./resolver.js";
import { applyToolGroups, probeTool } from "./tool-groups.js";

export interface ToolGroupPlan {
  tools: Record<string, ToolEntry>;
  ceiling: Capabilities;
  verdicts: ToolGroupVerdict[];
  augmented: AgentManifest;
  // Instance name → contributing group label, for source attribution.
  origins: Record<string, string>;
}

// The boot sequence shared by runAgent and audit. Sets
// `agent.capabilities`/`agent.toolVerdicts` as a side effect so sessions
// can trim their catalogs.
export function planToolGroups(args: {
  manifest: AgentManifest;
  groups: ToolGroup[];
  agent: Agent;
}): ToolGroupPlan {
  const { manifest, groups, agent } = args;
  const manifestTools: Record<string, ToolEntry> =
    manifest.tools ??
    Object.fromEntries(DEFAULT_BUILTIN_TOOLS.map((n) => [n, "builtin"]));
  const registry = buildNativeTools();
  const applied = applyToolGroups({
    manifestTools,
    capabilities: ceilingFor(manifest),
    groups,
    toolFor: (instance, underlying) =>
      probeTool(registry, instance, underlying, agent),
  });
  agent.capabilities = applied.ceiling;
  agent.toolVerdicts = applied.verdicts;
  return { ...applied, augmented: { ...manifest, tools: applied.tools } };
}

export function effectiveCeilingFor(manifest: AgentManifest): Capabilities {
  return effectiveCeiling(
    ceilingFor(manifest),
    manifest.tools ??
      Object.fromEntries(DEFAULT_BUILTIN_TOOLS.map((n) => [n, "builtin"])),
  );
}

// Spawn-time enforcement of the transitive ceiling: a child's effective
// ceiling must be contained, key by key, in the parent's. Audit reports
// the same containment statically; this makes it binding.
export function assertSubagentCeiling(
  parent: Agent,
  child: AgentManifest,
  who: string,
): void {
  const parentCeiling = parent.capabilities;
  if (parentCeiling === undefined) return;
  const childCeiling = effectiveCeilingFor(child);
  const registry = buildNativeTools();
  const violations: string[] = [];
  for (const [key, grant] of Object.entries(childCeiling)) {
    const tool = probeTool(registry, key, key, parent);
    if (!containsWithTool(tool, parentCeiling[key], grant)) {
      violations.push(key);
    }
  }
  if (violations.length > 0) {
    throw new CapabilityError(
      `${who} tried to spawn sub-agent '${child.name}' whose capability ` +
        `ceiling exceeds the parent's for: ${violations
          .map((k) => `'${k}'`)
          .join(", ")}. A sub-agent can only hold authority its parent ` +
        `holds. Narrow the sub-agent's [capabilities] (note: a missing ` +
        `section means the default ceiling, not an empty one — use ` +
        `\`capabilities: {}\` for none), or widen the parent's.`,
      Object.fromEntries(violations.map((k) => [k, childCeiling[k]])),
      parentCeiling,
    );
  }
}
