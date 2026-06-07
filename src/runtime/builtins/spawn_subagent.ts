import type {
  Agent,
  Tool,
  ToolConfig,
  ToolContext,
  ToolDisplay,
  ToolResult,
} from "../../types/interfaces.js";
import type {
  AgentManifest,
  Capabilities,
  CapabilitySet,
  ToolEntry,
} from "../../types/manifest.js";
import type { JSONSchema } from "../../types/schema.js";
import { lastAgentMessage } from "../extract-message.js";

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

function grantedManifest(
  capabilities: CapabilitySet | undefined,
): AgentManifest | undefined {
  if (capabilities === undefined || capabilities === "*") return undefined;
  const rows = Array.isArray(capabilities) ? capabilities : [capabilities];
  for (const row of rows) {
    if (isAgentManifest(row.manifest)) return row.manifest;
  }
  return undefined;
}

export class SpawnSubagentTool implements Tool {
  public readonly name = "spawn_subagent";
  public readonly description: string;
  public readonly inputSchema = SCHEMA;
  public readonly optional = ["manifest"];
  public readonly dependencies: { subagents: AgentManifest[] };
  public readonly isSelfCopy: boolean;

  // The sub-manifest IS the capability declaration, so it lives in the grant
  // (`manifest` kind), not in config; absent a grant we self-copy the parent.
  constructor(
    _config: ToolConfig,
    capabilities: CapabilitySet | undefined,
    agent?: Agent,
  ) {
    void _config;
    let manifest: AgentManifest | undefined;
    let selfCopy = false;
    const granted = grantedManifest(capabilities);
    if (granted) {
      manifest = granted;
    } else if (agent?.manifest) {
      manifest = cloneManifestWithoutSpawnSubagent(agent.manifest);
      selfCopy = true;
    }
    if (!manifest) {
      throw new Error(
        "spawn_subagent: no sub-manifest available. Grant one in " +
          "[capabilities] (spawn_subagent = { manifest = {...} }), or run " +
          "the tool through `runAgent` (which provides the owning agent's " +
          "manifest as the self-copy default).",
      );
    }
    this.dependencies = { subagents: [manifest] };
    this.isSelfCopy = selfCopy;
    this.description = selfCopy
      ? "Delegate a turn to a fresh copy of yourself."
      : `Delegate a turn to the '${manifest.name}' sub-agent${manifest.description ? `: ${manifest.description}` : ""}`;
  }

  get subagentManifest(): AgentManifest {
    const [first] = this.dependencies.subagents as [AgentManifest];
    return first;
  }

  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { prompt } = input as SpawnSubagentInput;
    if (!ctx.agent.spawnSubagent) {
      return {
        content:
          "spawn_subagent: ctx.agent has no spawnSubagent (was this tool dispatched outside a normal Loom runtime?)",
        isError: true,
      };
    }
    const subName = this.subagentManifest.name;
    const display: ToolDisplay = {
      title: this.isSelfCopy
        ? `spawn_subagent: copy of '${subName}'`
        : `spawn_subagent: ${subName}`,
      kind: "think",
    };
    let sub;
    try {
      sub = await ctx.agent.spawnSubagent(subName);
    } catch (e) {
      return { content: (e as Error).message, isError: true, display };
    }
    try {
      await sub.prompt(prompt);
      const text = await lastAgentMessage(sub.session);
      return { content: text, display };
    } catch (e) {
      return { content: (e as Error).message, isError: true, display };
    } finally {
      await sub.close();
    }
  }
}

function cloneManifestWithoutSpawnSubagent(
  parent: AgentManifest,
): AgentManifest {
  const parentKey = parent.manifestPath ?? `<inline:${parent.name}>`;
  const clone: AgentManifest = {
    ...parent,
    // Distinct manifestPath so the audit walker's cycle detection treats this as a separate node.
    manifestPath: `<self-copy:${parentKey}>`,
  };
  if (parent.tools !== undefined) {
    const tools: Record<string, ToolEntry> = { ...parent.tools };
    delete tools.spawn_subagent;
    clone.tools = tools;
  }
  if (parent.capabilities !== undefined) {
    const caps: Capabilities = { ...parent.capabilities };
    delete caps.spawn_subagent;
    clone.capabilities = caps;
  }
  return clone;
}
