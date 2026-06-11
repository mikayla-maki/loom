export {
  applyToolGroups,
  ceilingEntryFor,
  collectToolGroups,
  containsDeclaration,
  effectiveCeiling,
  toolGroupQualifies,
  underlyingNameOfEntry,
  type AppliedToolGroups,
  type DeclarationVerdict,
  type ToolGroupVerdict,
} from "@mcmaki/loom-capabilities";

import type { Agent, Tool, Tools } from "../types/interfaces.js";

// Builtin implementations are pure to construct, so a throwaway instance
// supplies the tool-owned algebra for pre-bind declaration checking.
export function probeTool(
  registry: Tools,
  instance: string,
  underlying: string,
  agent: Agent,
): Tool | undefined {
  try {
    const config = instance === underlying ? {} : { tool: underlying };
    const tool = registry.resolveTool?.(instance, config, agent, undefined);
    return tool instanceof Promise ? undefined : (tool ?? undefined);
  } catch {
    return undefined;
  }
}
