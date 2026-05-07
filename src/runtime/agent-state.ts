/**
 * AgentState — the runtime's read-only view of the agent's live skills,
 * capability ceiling, and tool table.
 *
 * Owned by `RunningAgentImpl`; the runtime instance per turn (`RuntimeImpl`)
 * borrows the same reference for system-prompt assembly and tool dispatch.
 *
 * Historically this was mutable, because the deleted `add_skill` builtin
 * grew the tool table and ceiling at runtime. With dynamic skill addition
 * gone, it's a plain typed bag — no setters, no `addSkill`. To bring more
 * skills into scope, run a fresh `runAgent()` with an updated manifest.
 */

import type { Capabilities, SkillManifest } from "../types/manifest.js";

import type { ToolTable } from "./tool-table.js";

export class AgentState {
  /** Read by RuntimeImpl every turn (when assembling the system prompt). */
  readonly skills: readonly SkillManifest[];
  /** The agent's effective per-tool capability ceiling. */
  readonly ceiling: Capabilities;
  /** Name→Tool registry the runtime executes against. */
  readonly toolTable: ToolTable;

  constructor(opts: {
    skills: SkillManifest[];
    ceiling: Capabilities;
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
}
