import { BashTool } from "../../runtime/builtins/bash.js";
import { EditFileTool } from "../../runtime/builtins/edit_file.js";
import { FindTool } from "../../runtime/builtins/find.js";
import { ReadFileTool } from "../../runtime/builtins/read_file.js";
import { SpawnSubagentTool } from "../../runtime/builtins/spawn_subagent.js";
import { WebSearchTool } from "../../runtime/builtins/web_search.js";
import { WriteFileTool } from "../../runtime/builtins/write_file.js";
import type { Agent, Tool, ToolConfig, Tools } from "../../types/interfaces.js";
import type { CapabilitySet } from "../../types/manifest.js";

type Builder = (
  config: ToolConfig,
  capabilities: CapabilitySet | undefined,
  agent: Agent,
) => Tool;

const BUILTINS: Record<string, Builder> = {
  bash: (c, caps) => new BashTool(c, caps),
  read_file: (c, caps) => new ReadFileTool(c, caps),
  write_file: (c, caps) => new WriteFileTool(c, caps),
  edit_file: (c, caps) => new EditFileTool(c, caps),
  find: (c, caps) => new FindTool(c, caps),
  spawn_subagent: (c, caps, agent) => new SpawnSubagentTool(c, caps, agent),
  web_search: (c, caps) => new WebSearchTool(c, caps),
};

class NativeTools implements Tools {
  resolveTool(
    name: string,
    config: ToolConfig,
    agent: Agent,
    capabilities: CapabilitySet | undefined,
  ): Tool | null {
    const builder = BUILTINS[name];
    return builder ? builder(config, capabilities, agent) : null;
  }
  close(): void {}
}

export function buildNativeTools(): Tools {
  return new NativeTools();
}

export function nativeBuiltinNames(): string[] {
  return Object.keys(BUILTINS).sort();
}
