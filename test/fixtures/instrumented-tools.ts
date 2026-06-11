/**
 * Test-only tools for exercising the embedder surface:
 *
 * - `ticker` publishes two interim progress updates via `ctx.progress` before
 *   returning, to test ephemeral tool progress.
 * - `trigger` invokes the callback installed via `onTrigger` mid-execution,
 *   so tests can deterministically steer the agent while a tool is running
 *   (the callback fires before the harness's post-batch drain point).
 */

import type {
  Agent,
  Tool,
  ToolConfig,
  ToolContext,
  ToolResult,
  Tools,
} from "../../src/types/interfaces.js";
import type { CapabilitySet } from "../../src/types/manifest.js";
import type { JSONSchema } from "../../src/types/schema.js";

const EMPTY_SCHEMA: JSONSchema = { type: "object" };

class TickerTool implements Tool {
  public readonly name = "ticker";
  public readonly description = "Emits two progress ticks. Test-only.";
  public readonly inputSchema = EMPTY_SCHEMA;
  public readonly capabilities: CapabilitySet;

  constructor(capabilities: CapabilitySet | undefined) {
    this.capabilities = capabilities ?? {};
  }

  async execute(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
    ctx.progress?.({ content: "tick 1" });
    ctx.progress?.({ content: "tick 2", title: "ticker" });
    return { content: "done" };
  }
}

class TriggerTool implements Tool {
  public readonly name = "trigger";
  public readonly description =
    "Calls the installed test callback mid-execution. Test-only.";
  public readonly inputSchema = EMPTY_SCHEMA;
  public readonly capabilities: CapabilitySet;

  constructor(
    capabilities: CapabilitySet | undefined,
    private readonly callback: () => void,
  ) {
    this.capabilities = capabilities ?? {};
  }

  async execute(_input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    this.callback();
    return { content: "triggered" };
  }
}

export function instrumentedToolsProvider(hooks: {
  onTrigger?: () => void;
}): Tools {
  return {
    resolveTool(
      name: string,
      _config: ToolConfig,
      _agent: Agent,
      capabilities: CapabilitySet | undefined,
    ): Tool | null {
      if (name === "ticker") return new TickerTool(capabilities);
      if (name === "trigger") {
        return new TriggerTool(capabilities, () => hooks.onTrigger?.());
      }
      return null;
    },
    close() {
      /* noop */
    },
  };
}
