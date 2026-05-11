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
 * No on-disk format. No process-tool framework. No path/registry
 * resolution. Just JS objects.
 */

import { BashTool } from "../../runtime/builtins/bash.js";
import { FindTool } from "../../runtime/builtins/find.js";
import { ReadFileTool } from "../../runtime/builtins/read_file.js";
import { SpawnSubagentTool } from "../../runtime/builtins/spawn_subagent.js";
import { WriteFileTool } from "../../runtime/builtins/write_file.js";
import type { Agent, Tool, ToolConfig, Tools } from "../../types/interfaces.js";
import type { CapabilitySet } from "../../types/manifest.js";

type Builder = (
  config: ToolConfig,
  capabilities: CapabilitySet | undefined,
) => Tool;

const BUILTINS: Record<string, Builder> = {
  bash: (c, caps) => new BashTool(c, caps),
  find: (c, caps) => new FindTool(c, caps),
  read_file: (c, caps) => new ReadFileTool(c, caps),
  write_file: (c, caps) => new WriteFileTool(c, caps),
  spawn_subagent: (c, caps) => new SpawnSubagentTool(c, caps),
};

class NativeTools implements Tools {
  // Native builtins don't read the agent at construction time — they
  // see it on every call via `ctx.agent`. The arg is accepted for
  // signature parity with provider-contributed Tools instances.
  resolveTool(
    name: string,
    config: ToolConfig,
    _agent: Agent,
    capabilities: CapabilitySet | undefined,
  ): Tool | null {
    void _agent;
    const builder = BUILTINS[name];
    return builder ? builder(config, capabilities) : null;
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
