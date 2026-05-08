/**
 * AgentState — the runtime's read-only view of the agent's capability
 * ceiling and tool table.
 *
 * Owned by `RunningAgentImpl`; the runtime instance per turn (`RuntimeImpl`)
 * borrows the same reference for system-prompt assembly and tool dispatch.
 */

import type { Capabilities } from "../types/manifest.js";

import type { ToolTable } from "./tool-table.js";

export class AgentState {
  /** The agent's effective per-tool capability ceiling. */
  readonly ceiling: Capabilities;
  /** Name→Tool registry the runtime executes against. */
  readonly toolTable: ToolTable;

  constructor(opts: { ceiling: Capabilities; toolTable: ToolTable }) {
    this.ceiling = { ...opts.ceiling };
    this.toolTable = opts.toolTable;
  }

  hasTool(name: string): boolean {
    return this.toolTable.has(name);
  }
}
