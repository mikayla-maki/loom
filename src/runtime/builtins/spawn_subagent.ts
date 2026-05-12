/**
 * `spawn_subagent` — runs a sub-agent end-to-end and returns its
 * final assistant message.
 *
 * Two modes:
 *
 *   1. **Configured sub-manifest** (explicit). The config carries an
 *      `AgentManifest` — either as the config itself, or under
 *      `config.manifest`. The tool delegates each call to that
 *      sub-agent.
 *
 *   2. **Self-copy default** (implicit). When no manifest is
 *      configured, the tool clones the owning agent's manifest
 *      *minus* its own `spawn_subagent` entry — so each spawned copy
 *      is a fresh instance of the parent, but the recursion bottoms
 *      out one level deep (the clone has no spawn_subagent of its
 *      own). Sub-agents share storage with the parent by default
 *      (same `name` / `storageId`); use an explicit manifest if you
 *      need isolation.
 *
 * Either way, the resolved sub-manifest is placed in the tool's
 * `dependencies.subagents` list so `loom audit` walks it.
 *
 * The tool is opt-in: it isn't part of the default builtin set
 * (`bash`, `read_file`, `write_file`, `edit_file`). Manifests that
 * want it declare it explicitly under `[tools.spawn_subagent]`.
 * `find` and `web_search` are the other opt-in builtins — same
 * pattern. The native provider only claims that one name, so each
 * manifest gets one builtin sub-agent slot — if you need several,
 * write a tiny custom Tool that closes over a different sub-manifest
 * each time.
 *
 * No fan-up: the sub-agent's `SessionUpdate` stream isn't merged back
 * into the parent's. The parent sees a single tool result. Consumers
 * who want streaming visibility should subscribe to
 * `subAgent.updates()` themselves and write a custom tool.
 */

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
  public readonly name = "spawn_subagent";
  public readonly description: string;
  public readonly inputSchema = SCHEMA;
  public readonly dependencies: { subagents: AgentManifest[] };
  /**
   * True when the sub-manifest was synthesised by cloning the owning
   * agent's manifest (rather than supplied via config). Exposed for
   * tests / introspection.
   */
  public readonly isSelfCopy: boolean;

  constructor(
    config: ToolConfig,
    _capabilities: CapabilitySet | undefined,
    agent?: Agent,
  ) {
    void _capabilities;
    if (typeof config === "string" || config === null) {
      throw new Error(
        "spawn_subagent requires an object config carrying the sub-manifest (either as the config itself or under `config.manifest`), or no config at all to default to cloning the owning agent.",
      );
    }
    const c = (config ?? {}) as Record<string, unknown> & {
      manifest?: unknown;
    };

    let manifest: AgentManifest | undefined;
    let selfCopy = false;
    if (isAgentManifest(c.manifest)) {
      manifest = c.manifest;
    } else if (isAgentManifest(c)) {
      manifest = c as unknown as AgentManifest;
    } else if (agent?.manifest) {
      manifest = cloneManifestWithoutSpawnSubagent(agent.manifest);
      selfCopy = true;
    }
    if (!manifest) {
      throw new Error(
        "spawn_subagent: no sub-manifest available. Pass an `AgentManifest` " +
          "directly as the config, place one under `config.manifest`, or run " +
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

  /** Stable handle to the configured sub-manifest (for tests). */
  get subagentManifest(): AgentManifest {
    // The constructor always populates `subagents` with exactly one
    // manifest; this getter is here for tests and never observes the
    // pre-init state.
    const [first] = this.dependencies.subagents as [AgentManifest];
    return first;
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
    const subName = this.subagentManifest.name;
    const display: ToolDisplay = {
      title: this.isSelfCopy
        ? `spawn_subagent: copy of '${subName}'`
        : `spawn_subagent: ${subName}`,
      kind: "think",
    };
    const sub = await ctx.agent.spawnSubagent(subName);
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

/**
 * Produce a sub-manifest that's a structural copy of `parent` but
 * with `spawn_subagent` stripped from `tools` and `capabilities` so
 * the clone can't recursively re-spawn itself. The runtime treats
 * the result as a fresh `AgentManifest` instance — shared references
 * to `Harness` / `Session` pre-built instances flow through, by
 * design (an explicit `Session` instance the user pre-built is theirs
 * to share).
 *
 * The clone is given a synthesized `manifestPath` of the form
 * `<self-copy:<parent-key>>` so the audit walker's cycle detection
 * (keyed on `manifestPath`) sees it as a distinct node from the
 * parent and walks into it once — surfacing the stripped tools/caps
 * — rather than bailing out with a `(cycle)` stub. The clone has no
 * `spawn_subagent` of its own, so the recursion bottoms out
 * naturally there. Storage is unaffected (storage uses
 * `storageId ?? name`, neither of which we touch), so the clone
 * still shares state with the parent by default.
 */
function cloneManifestWithoutSpawnSubagent(
  parent: AgentManifest,
): AgentManifest {
  const parentKey = parent.manifestPath ?? `<inline:${parent.name}>`;
  const clone: AgentManifest = {
    ...parent,
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
