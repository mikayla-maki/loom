/**
 * Native Loom provider — supplies the builtin tools.
 *
 * Each builtin is a JS class in `src/runtime/builtins/`. The provider
 * holds a name → constructor map and dispatches on `resolveTool(name,
 * config, agent, capabilities)`. Returns null for names it doesn't
 * know — the next provider in the chain (if any) gets a turn.
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
import { EchoTool } from "../../runtime/builtins/echo.js";
import { FindTool } from "../../runtime/builtins/find.js";
import { ReadFileTool } from "../../runtime/builtins/read_file.js";
import { SpawnSubagentTool } from "../../runtime/builtins/spawn_subagent.js";
import { WriteFileTool } from "../../runtime/builtins/write_file.js";
import type {
  Agent,
  Provider,
  ProviderFactory,
  Tool,
  ToolConfig,
} from "../../types/interfaces.js";
import type { CapabilitySet } from "../../types/manifest.js";

type Builder = (
  config: ToolConfig,
  capabilities: CapabilitySet | undefined,
) => Tool;

const BUILTINS: Record<string, Builder> = {
  bash: (c, caps) => new BashTool(c, caps),
  echo: (c, caps) => new EchoTool(c, caps),
  find: (c, caps) => new FindTool(c, caps),
  read_file: (c, caps) => new ReadFileTool(c, caps),
  write_file: (c, caps) => new WriteFileTool(c, caps),
  spawn_subagent: (c, caps) => new SpawnSubagentTool(c, caps),
};

class NativeProvider implements Provider {
  // Native builtins don't read the agent at construction time — they
  // see it on every call via `ctx.agent`. The arg is accepted for
  // signature parity with extension providers.
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

export const nativeProviderFactory: ProviderFactory = {
  name: "native",
  create: () => new NativeProvider(),
};

export function buildNativeProvider(): Provider {
  return new NativeProvider();
}

/** The set of names this provider claims; useful for audits / diagnostics. */
export function nativeBuiltinNames(): string[] {
  return Object.keys(BUILTINS).sort();
}
