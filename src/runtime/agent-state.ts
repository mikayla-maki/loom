/**
 * AgentState — the mutable part of a running agent.
 *
 * Owns the live skills list, capability ceiling, and tool table. Both
 * `RunningAgentImpl` and `RuntimeImpl` hold a reference to the same
 * `AgentState` instance, so that when an in-process tool such as `add_skill`
 * mutates state, the next turn's system prompt and tool catalog reflect it.
 *
 * Mutation is exclusive: `addSkill` is the only entry point. It returns the
 * effective ceiling diff (caller uses this to decide whether a permission
 * prompt was actually needed).
 */

import type { SkillManifest, SandboxCeiling } from "../types/manifest.js";
import type { Tool } from "../types/interfaces.js";

import { unionCapabilities } from "../manifest/capabilities.js";
import type { ToolTable } from "./tool-table.js";

export interface AddSkillArgs {
  skill: SkillManifest;
  tools: Tool[];
  /** Capabilities the new tools collectively require. */
  required: SandboxCeiling;
  /** Secrets to merge into the runtime secret store. */
  secrets?: Record<string, string>;
}

export interface AddSkillOutcome {
  added: true;
  /** New tool names made visible to the model. */
  newTools: string[];
  /** Capabilities granted by this addition (post-expansion view). */
  ceilingAfter: SandboxCeiling;
  /** Whether the agent's ceiling actually had to grow. */
  ceilingChanged: boolean;
}

export class AgentState {
  /** Read by RuntimeImpl every turn (when assembling the system prompt). */
  readonly skills: SkillManifest[];
  /** The currently-effective capability ceiling. Mutates as add_skill expands it. */
  ceiling: SandboxCeiling;
  /** Mutable name→Tool table the runtime executes against. */
  readonly toolTable: ToolTable;

  constructor(opts: {
    skills: SkillManifest[];
    ceiling: SandboxCeiling;
    toolTable: ToolTable;
  }) {
    this.skills = [...opts.skills];
    this.ceiling = { ...opts.ceiling };
    this.toolTable = opts.toolTable;
  }

  hasSkill(name: string): boolean {
    return this.skills.some((s) => s.name === name);
  }
  hasTool(name: string): boolean {
    return this.toolTable.has(name);
  }

  addSkill(args: AddSkillArgs): AddSkillOutcome {
    const newTools: string[] = [];
    for (const t of args.tools) {
      if (this.toolTable.addTool(t)) newTools.push(t.name);
    }
    if (args.secrets) this.toolTable.addSecrets(args.secrets);

    const before = this.ceiling;
    const after = unionCapabilities([before, args.required]);
    const ceilingChanged =
      JSON.stringify(normalize(before)) !== JSON.stringify(normalize(after));
    this.ceiling = after;

    if (args.skill.name && !this.hasSkill(args.skill.name)) {
      this.skills.push(args.skill);
    }
    return { added: true, newTools, ceilingAfter: after, ceilingChanged };
  }
}

function normalize(c: SandboxCeiling): Record<string, unknown> {
  return {
    filesystem: [...(c.filesystem ?? [])].sort(),
    network: [...(c.network ?? [])].sort(),
    secrets: [...(c.secrets ?? [])].sort(),
  };
}
