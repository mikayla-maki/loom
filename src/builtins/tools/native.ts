/**
 * Native Loom Tools provider — supplies the builtin tools.
 *
 * Each builtin is a JS class in `src/runtime/builtins/`. The `Tools`
 * instance holds a name → constructor map and dispatches on
 * `resolveTool(name, config, agent, capabilities)`. Returns null for
 * names it doesn't know.
 *
 * Builtin constructors take `(config, capabilities)`. Capabilities are
 * the tool's grant from `manifest.capabilities[name]` (or undefined when
 * the manifest declares none); each tool stores it on `this.capabilities`
 * for self-policing and derives its description / input schema from it.
 *
 * Default vs. opt-in:
 *
 *   - **Default** (auto-loaded when `[tools]` is absent): `bash`,
 *     `read_file`, `write_file`, `edit_file`.
 *   - **Opt-in built-ins** (available but not auto-loaded): `find`,
 *     `spawn_subagent`, `web_search`. List them as `<name> = "builtin"`
 *     in `[tools]` to pull them in.
 *
 * No on-disk format. No process-tool framework. No path/registry
 * resolution. Just JS objects.
 */

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
  // Most native builtins don't read the agent at construction time —
  // they see it on every call via `ctx.agent`. `spawn_subagent` is
  // the exception: it reads `agent.manifest` at boot to support its
  // self-copy default (empty config → clone the owning agent). The
  // Builder signature passes `agent` uniformly so that escape hatch
  // is cheap; builders that don't need it ignore it.
  resolveTool(
    name: string,
    config: ToolConfig,
    agent: Agent,
    capabilities: CapabilitySet | undefined,
  ): Tool | null {
    const builder = BUILTINS[name];
    return builder ? builder(config, capabilities, agent) : null;
  }
  close(): void {
    /* nothing to clean up */
  }
}

export function buildNativeTools(): Tools {
  return new NativeTools();
}

/** The set of names this provider claims; useful for audits / diagnostics. */
export function nativeBuiltinNames(): string[] {
  return Object.keys(BUILTINS).sort();
}
