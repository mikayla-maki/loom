import { resolveConfiguredSkillRoots } from "../builtins/session/skills.js";
import { buildNativeTools } from "../builtins/tools/native.js";
import type { Agent } from "../types/interfaces.js";
import type {
  AgentManifest,
  Capabilities,
  CapabilitySet,
  ToolEntry,
  ToolGroup,
  ToolGroupVerdict,
} from "../types/manifest.js";
import {
  DEFAULT_BUILTIN_TOOLS,
  isPreBuiltSessionLayer,
  type ResolvedSessionLayer,
  type SessionBinding,
} from "./resolver.js";
import { applyToolGroups, probeTool } from "./tool-groups.js";

export const DEFAULT_TOP_LEVEL_CAPABILITIES = {
  bash: { commands: "*", paths: ["./"] },
  read_file: { paths: ["./"] },
  write_file: { paths: ["./"] },
  edit_file: { paths: ["./"] },
} as const satisfies Record<string, CapabilitySet>;

export const DEFAULT_SESSION_CHAIN_PROVIDERS = [
  "skills",
  "compacting",
  "in-memory",
] as const;

// An explicit [capabilities] section IS the ceiling, verbatim; absent one,
// the default pool applies (FS/shell tools over cwd, plus read access to
// configured skill roots).
export function ceilingFor(
  manifest: AgentManifest,
  manifestDir: string,
  sessionLayers: ResolvedSessionLayer[] | undefined,
): Capabilities {
  if (manifest.capabilities !== undefined) return manifest.capabilities;
  const defaults: Capabilities = { ...DEFAULT_TOP_LEVEL_CAPABILITIES };
  const skillRoots = skillRootsFromLayers(sessionLayers, manifestDir);
  if (skillRoots.length > 0) {
    defaults.read_file = { paths: ["./", ...skillRoots] };
    defaults.find = { paths: ["./", ...skillRoots] };
  }
  return defaults;
}

export interface ToolGroupPlan {
  tools: Record<string, ToolEntry>;
  ceiling: Capabilities;
  verdicts: ToolGroupVerdict[];
  augmented: AgentManifest;
}

// Shared by runAgent and audit. Sets `agent.capabilities`/`agent.toolVerdicts`
// as a side effect so sessions can trim their catalogs.
export function planToolGroups(args: {
  manifest: AgentManifest;
  manifestDir: string;
  sessionLayers: ResolvedSessionLayer[] | undefined;
  groups: ToolGroup[];
  agent: Agent;
}): ToolGroupPlan {
  const { manifest, manifestDir, sessionLayers, groups, agent } = args;
  const manifestTools: Record<string, ToolEntry> =
    manifest.tools ??
    Object.fromEntries(DEFAULT_BUILTIN_TOOLS.map((n) => [n, "builtin"]));
  const registry = buildNativeTools();
  const applied = applyToolGroups({
    manifestTools,
    capabilities: ceilingFor(manifest, manifestDir, sessionLayers),
    groups,
    toolFor: (instance, underlying) =>
      probeTool(registry, instance, underlying, agent),
  });
  agent.capabilities = applied.ceiling;
  agent.toolVerdicts = applied.verdicts;
  return { ...applied, augmented: { ...manifest, tools: applied.tools } };
}

function skillRootsFromLayers(
  sessionLayers: ResolvedSessionLayer[] | undefined,
  manifestDir: string,
): string[] {
  const layers: Array<{
    factoryName: string;
    config: Record<string, unknown>;
  }> =
    sessionLayers && sessionLayers.length > 0
      ? sessionLayers.filter(
          (l): l is SessionBinding => !isPreBuiltSessionLayer(l),
        )
      : DEFAULT_SESSION_CHAIN_PROVIDERS.map((name) => ({
          factoryName: name,
          config: {},
        }));
  const roots: string[] = [];
  for (const layer of layers) {
    if (layer.factoryName !== "skills") continue;
    roots.push(...resolveConfiguredSkillRoots(layer.config, manifestDir));
  }
  return [...new Set(roots)];
}
