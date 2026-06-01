import type { Capabilities } from "../types/manifest.js";

import type { ToolTable } from "./tool-table.js";

export class AgentState {
  readonly grants: Capabilities;
  readonly toolTable: ToolTable;

  constructor(opts: { grants: Capabilities; toolTable: ToolTable }) {
    this.grants = { ...opts.grants };
    this.toolTable = opts.toolTable;
  }

  hasTool(name: string): boolean {
    return this.toolTable.has(name);
  }
}
