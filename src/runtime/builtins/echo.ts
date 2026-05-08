/**
 * `echo` — return the provided text. Useful for tests and trivial responses.
 */

import type {
  Tool,
  ToolConfig,
  ToolContext,
  ToolResult,
} from "../../types/interfaces.js";
import type { CapabilitySet } from "../../types/manifest.js";
import type { JSONSchema } from "../../types/schema.js";

const SCHEMA: JSONSchema = {
  type: "object",
  required: ["text"],
  properties: { text: { type: "string" } },
};

export class EchoTool implements Tool {
  public readonly name = "echo";
  public readonly description =
    "Return the provided text. Useful for tests and trivial responses.";
  public readonly inputSchema = SCHEMA;
  // No requires — echo does no IO. Capabilities ignored.

  constructor(_config: ToolConfig, _capabilities: CapabilitySet | undefined) {
    /* no config, no caps */
  }

  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const text = (input as { text?: unknown }).text;
    return { content: typeof text === "string" ? text : String(text ?? "") };
  }
}
