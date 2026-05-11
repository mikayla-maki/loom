/**
 * Test-only echo tool. Used to be a builtin; moved here because nothing
 * outside the test suite has a reason to use it. Tests that need echo
 * callable pass `echoTestProvider` to `runAgent` via the `providers`
 * option; the SDK provider chain finds it before the native provider
 * for `provider = "builtin"` resolution.
 */

import type {
  Agent,
  Tools,
  Tool,
  ToolConfig,
  ToolContext,
  ToolResult,
} from "../../src/types/interfaces.js";
import type { CapabilitySet } from "../../src/types/manifest.js";
import type { JSONSchema } from "../../src/types/schema.js";

const SCHEMA: JSONSchema = {
  type: "object",
  required: ["text"],
  properties: { text: { type: "string" } },
};

export class EchoTool implements Tool {
  public readonly name = "echo";
  public readonly description = "Return the provided text. Test-only.";
  public readonly inputSchema = SCHEMA;
  public readonly capabilities: CapabilitySet;

  constructor(_config: ToolConfig, capabilities: CapabilitySet | undefined) {
    this.capabilities = capabilities ?? {};
  }

  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const text = (input as { text?: unknown }).text;
    return { content: typeof text === "string" ? text : String(text ?? "") };
  }
}

/** SDK provider that resolves the test echo tool. Pass via `RunAgentOptions.providers`. */
export const echoTestProvider: Tools = {
  resolveTool(
    name: string,
    config: ToolConfig,
    _agent: Agent,
    capabilities: CapabilitySet | undefined,
  ): Tool | null {
    if (name === "echo") return new EchoTool(config, capabilities);
    return null;
  },
  close() {
    /* noop */
  },
};
