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

function underlyingNameOf(name: string, config: ToolConfig): string {
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const v = (config as Record<string, unknown>)["tool"];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return name;
}

function renameTool(tool: Tool, instanceName: string): Tool {
  const renamed: Tool = {
    name: instanceName,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.requires !== undefined ? { requires: tool.requires } : {}),
    ...(tool.optional !== undefined ? { optional: tool.optional } : {}),
    ...(tool.capabilities !== undefined
      ? { capabilities: tool.capabilities }
      : {}),
    ...(tool.secrets !== undefined ? { secrets: tool.secrets } : {}),
    ...(tool.dependencies !== undefined
      ? { dependencies: tool.dependencies }
      : {}),
    execute: (input, ctx) => tool.execute(input, ctx),
  };
  if (tool.containsGrant) {
    renamed.containsGrant = tool.containsGrant.bind(tool);
  }
  if (tool.mergeGrants) {
    renamed.mergeGrants = tool.mergeGrants.bind(tool);
  }
  if (tool.sampleGrant) {
    renamed.sampleGrant = tool.sampleGrant.bind(tool);
  }
  if (tool.audit) {
    renamed.audit = tool.audit.bind(tool);
  }
  return renamed;
}

class NativeTools implements Tools {
  resolveTool(
    name: string,
    config: ToolConfig,
    agent: Agent,
    capabilities: CapabilitySet | undefined,
  ): Tool | null {
    const underlying = underlyingNameOf(name, config);
    const builder = BUILTINS[underlying];
    if (!builder) return null;
    const tool = builder(config, capabilities, agent);
    return underlying === name ? tool : renameTool(tool, name);
  }
  close(): void {}
}

export function buildNativeTools(): Tools {
  return new NativeTools();
}

export function nativeBuiltinNames(): string[] {
  return Object.keys(BUILTINS).sort();
}
