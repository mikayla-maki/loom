/**
 * Native Loom provider — supplies the builtin tools.
 *
 * Each builtin is a JS class in `src/runtime/builtins/`. The provider
 * holds a name → constructor map and dispatches on `resolveTool(name,
 * config)`. Returns null for names it doesn't know — the next provider
 * in the chain (if any) gets a turn.
 *
 * No on-disk format. No process-tool framework. No path/registry
 * resolution. Just JS objects.
 */

import { BashTool } from "../../runtime/builtins/bash.js";
import { EchoTool } from "../../runtime/builtins/echo.js";
import { FindTool } from "../../runtime/builtins/find.js";
import { ReadFileTool } from "../../runtime/builtins/read_file.js";
import { SearchSkillsTool } from "../../runtime/builtins/search_skills.js";
import { SpawnSubagentTool } from "../../runtime/builtins/spawn_subagent.js";
import { WriteFileTool } from "../../runtime/builtins/write_file.js";
import type {
  Provider,
  ProviderFactory,
  Tool,
  ToolConfig,
} from "../../types/interfaces.js";

type Builder = (config: ToolConfig) => Tool;

const BUILTINS: Record<string, Builder> = {
  bash: (c) => new BashTool(c),
  echo: (c) => new EchoTool(c),
  find: (c) => new FindTool(c),
  read_file: (c) => new ReadFileTool(c),
  write_file: (c) => new WriteFileTool(c),
  search_skills: (c) => new SearchSkillsTool(c),
  spawn_subagent: (c) => new SpawnSubagentTool(c),
};

class NativeProvider implements Provider {
  resolveTool(name: string, config: ToolConfig): Tool | null {
    const builder = BUILTINS[name];
    return builder ? builder(config) : null;
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
