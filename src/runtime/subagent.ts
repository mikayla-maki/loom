/**
 * In-process spawn_subagent tool.
 *
 * The v0 design ships spawn-subagent as a builtin tool (process-backed). v1
 * tightens this with a token-broker pattern: tools never resolve subagent
 * paths themselves; they ask the runtime, which checks the calling skill's
 * declared subagents against the agent's [sandbox].subagent ceiling.
 *
 * In-process means: no subprocess Glass cold-start, no env-var registry,
 * no socket. The parent Glass directly instantiates a child RunningAgent
 * via runAgent(), drives one prompt, extracts the final agent message,
 * and returns it.
 *
 * The subagent's own [sandbox] applies — children do NOT inherit the
 * parent's capabilities. That falls out of just calling runAgent() on the
 * child manifest.
 */

import { connectAcpUrl } from "../acp/client.js";
import { ResolutionError } from "../errors.js";
import { runAgent, type RunAgentOptions } from "../sdk/run-agent.js";
import type { ResolvedSubagent } from "../manifest/resolver.js";
import type { Capabilities } from "../types/manifest.js";
import type { Tool, ToolResult } from "../types/interfaces.js";
import { lastAgentMessage } from "./extract-message.js";

export interface SubagentRegistryEntry {
  /** The resolved subagent reference. */
  ref: ResolvedSubagent;
  /** Which skill declared this entry (for token-broker auditability). */
  skill: string;
}

/**
 * The runtime-side registry of subagents available to the agent.
 *
 * Entries are keyed by name (the model uses this name as the `scope` arg).
 * If the agent's `[sandbox].subagent === "*"`, any name is admissible at
 * resolution time as long as the skill that declared it is on this list.
 */
export class SubagentRegistry {
  private readonly byName = new Map<string, SubagentRegistryEntry>();

  constructor(
    entries: Iterable<SubagentRegistryEntry & { name: string }>,
    public readonly ceiling: Capabilities,
  ) {
    for (const e of entries) {
      this.byName.set(e.name, { ref: e.ref, skill: e.skill });
    }
  }

  /** All known names. */
  names(): string[] {
    return [...this.byName.keys()];
  }

  /**
   * Resolve a scope: returns the entry, or throws if either the name is
   * unknown or it falls outside the agent's ceiling.
   */
  resolve(scope: string): SubagentRegistryEntry {
    const entry = this.byName.get(scope);
    if (!entry) {
      throw new ResolutionError(
        `Unknown subagent scope '${scope}'. Available: ${this.names().join(", ") || "(none)"}`,
      );
    }
    const c = this.ceiling.subagent;
    if (c !== "*") {
      const allowed = new Set<string>(c ?? []);
      if (!allowed.has(scope)) {
        throw new ResolutionError(
          `Subagent '${scope}' is declared by skill '${entry.skill}' but not permitted by [sandbox].subagent. Add it to the ceiling.`,
        );
      }
    }
    return entry;
  }
}

import type { JSONSchema } from "../types/schema.js";

const SPAWN_SCHEMA: JSONSchema = {
  type: "object",
  required: ["scope", "prompt"],
  properties: {
    scope: {
      type: "string",
      description:
        "The subagent name (as declared by a skill's `subagents` map) to invoke.",
    },
    prompt: {
      type: "string",
      description: "Prompt to send to the subagent.",
    },
  },
};

/**
 * In-process subagent tool. Instances are created by run-agent.ts when the
 * resolved agent has any subagents declared by its skills.
 */
export class SpawnSubagentTool implements Tool {
  public readonly name = "spawn_subagent";
  public readonly description =
    "Run another Glass agent (a subagent) and return its final assistant message.";
  public readonly inputSchema = SPAWN_SCHEMA;

  constructor(
    private readonly registry: SubagentRegistry,
    private readonly options: { runOptions?: RunAgentOptions } = {},
  ) {}

  async execute(input: unknown, _secrets: Record<string, string>): Promise<ToolResult> {
    const params = (input ?? {}) as { scope?: string; prompt?: string };
    if (typeof params.scope !== "string" || typeof params.prompt !== "string") {
      return { content: "spawn_subagent: 'scope' and 'prompt' are required strings", isError: true };
    }

    let entry: SubagentRegistryEntry;
    try {
      entry = this.registry.resolve(params.scope);
    } catch (e) {
      return { content: (e as Error).message, isError: true };
    }

    try {
      const final = await this.runOne(entry, params.prompt);
      return { content: final };
    } catch (e) {
      return { content: `spawn_subagent error: ${(e as Error).message}`, isError: true };
    }
  }

  private async runOne(entry: SubagentRegistryEntry, prompt: string): Promise<string> {
    const ref = entry.ref;
    if (ref.kind === "acp") {
      const client = await connectAcpUrl(ref.url);
      try {
        const ns = client.agentName
          ? await client.newSession(client.agentName, { byName: true })
          : await client.newSession();
        const r = await client.prompt({ sessionId: ns.sessionId, prompt });
        return r.finalMessage ?? "";
      } finally {
        await client.close();
      }
    }
    if (ref.kind === "inline") {
      throw new Error("inline subagent manifests are not yet supported");
    }
    const manifestPath =
      ref.kind === "path" ? ref.path : ref.resolvedPath;
    const sub = await runAgent(manifestPath, this.options.runOptions ?? {});
    try {
      await sub.prompt(prompt);
      return await lastAgentMessage(sub.session);
    } finally {
      await sub.close();
    }
  }
}
