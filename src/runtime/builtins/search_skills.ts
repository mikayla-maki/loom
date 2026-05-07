/**
 * `search_skills` — thin wrapper over `ctx.searchSkills` letting the
 * model enumerate the agent's loaded skills.
 */

import type {
  Tool,
  ToolConfig,
  ToolContext,
  ToolResult,
} from "../../types/interfaces.js";
import type { JSONSchema } from "../../types/schema.js";

const SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Optional substring filter on name + description.",
    },
  },
};

export class SearchSkillsTool implements Tool {
  public readonly name = "search_skills";
  public readonly description =
    "List skills available to this agent. Read-only.";
  public readonly inputSchema = SCHEMA;

  constructor(_config: ToolConfig) {
    /* no config */
  }

  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const q = (input as { query?: unknown } | undefined)?.query;
    const query = typeof q === "string" && q ? q : undefined;
    const summaries = await ctx.searchSkills(query);
    return { content: JSON.stringify(summaries, null, 2) };
  }
}
