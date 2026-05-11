/**
 * `spawn_subagent` — runs a sub-agent end-to-end and returns its
 * final assistant message.
 *
 * Config: a single sub-manifest is provided inline through `config`
 * — either as the full `AgentManifest` shape, or under `config.manifest`.
 * That manifest is also placed into the tool's
 * `dependencies.subagents` list so `loom audit` walks it.
 *
 * The tool is opt-in: it isn't part of the default builtin set
 * (`bash`, `read_file`, `write_file`, `find`). Manifests that want it
 * declare it explicitly under `[tools.spawn_subagent]`. The native
 * provider only claims that one name, so each manifest gets one
 * builtin sub-agent slot — if you need several, write a tiny custom
 * Tool that closes over a different sub-manifest each time.
 *
 * No fan-up: the sub-agent's `SessionUpdate` stream isn't merged back
 * into the parent's. The parent sees a single tool result. Consumers
 * who want streaming visibility should subscribe to
 * `subAgent.updates()` themselves and write a custom tool.
 */

import type {
  Tool,
  ToolConfig,
  ToolContext,
  ToolResult,
} from "../../types/interfaces.js";
import type { AgentManifest, CapabilitySet } from "../../types/manifest.js";
import type { JSONSchema } from "../../types/schema.js";
import { lastAgentMessage } from "../extract-message.js";

/**
 * Input schema. `ToolTable` validates against this before dispatch —
 * `execute()` may trust `prompt` is a non-empty string.
 */
const SCHEMA: JSONSchema = {
  type: "object",
  required: ["prompt"],
  additionalProperties: false,
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      description:
        "The user message to send to the sub-agent. The sub-agent runs one turn and returns its final assistant message.",
    },
  },
};

interface SpawnSubagentInput {
  prompt: string;
}

function isAgentManifest(v: unknown): v is AgentManifest {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { name?: unknown }).name === "string" &&
    "harness" in (v as object)
  );
}

export class SpawnSubagentTool implements Tool {
  public readonly name: string;
  public readonly description: string;
  public readonly inputSchema = SCHEMA;
  public readonly dependencies: { subagents: AgentManifest[] };

  constructor(config: ToolConfig, _capabilities: CapabilitySet | undefined) {
    void _capabilities;
    if (typeof config === "string" || config === null) {
      throw new Error(
        "spawn_subagent requires an object config carrying the sub-manifest (either as the config itself or under `config.manifest`).",
      );
    }
    let manifest: AgentManifest | undefined;
    const c = config as Record<string, unknown> & { manifest?: unknown };
    if (isAgentManifest(c.manifest)) {
      manifest = c.manifest;
    } else if (isAgentManifest(c)) {
      manifest = c as unknown as AgentManifest;
    }
    if (!manifest) {
      throw new Error(
        "spawn_subagent: missing sub-manifest. Pass an `AgentManifest` directly as the config, or place one under `config.manifest`.",
      );
    }
    this.dependencies = { subagents: [manifest] };
    // Surface the sub-agent's identity in the tool description so the
    // parent model knows what the tool is for.
    const desc = manifest.description ? `: ${manifest.description}` : "";
    this.description = `Delegate a turn to the '${manifest.name}' sub-agent${desc}`;
    this.name = "spawn_subagent";
  }

  /** Stable handle to the configured sub-manifest (for tests). */
  get subagentManifest(): AgentManifest {
    return this.dependencies.subagents[0]!;
  }

  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { prompt } = input as SpawnSubagentInput;
    if (!ctx.agent.spawnSubagent) {
      // Should be unreachable: the runtime always attaches
      // spawnSubagent to ctx.agent. Defensive guard for direct
      // callers that hand-build a ToolContext.
      return {
        content:
          "spawn_subagent: ctx.agent has no spawnSubagent (was this tool dispatched outside a normal Loom runtime?)",
        isError: true,
      };
    }
    const sub = await ctx.agent.spawnSubagent(
      this.dependencies.subagents[0]!.name,
    );
    try {
      await sub.prompt(prompt);
      const text = await lastAgentMessage(sub.session);
      return { content: text };
    } catch (e) {
      return { content: (e as Error).message, isError: true };
    } finally {
      await sub.close();
    }
  }
}
