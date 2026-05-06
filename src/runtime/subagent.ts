/**
 * In-process spawn_subagent tool.
 *
 * The model invokes a subagent by name; the registry maps that name to a
 * resolved reference (path / registry-resolved path / acp:// URL), which
 * came from some skill's `subagents:` declaration. There is no separate
 * agent-level subagent ceiling — a skill that declared the subagent is
 * the contract.
 *
 * In-process means: no subprocess Loom cold-start, no env-var registry,
 * no socket. The parent Loom directly instantiates a child RunningAgent
 * via runAgent(), drives one prompt, extracts the final agent message,
 * and returns it.
 *
 * The broker socket exists for a different audience: spawned tool
 * subprocesses that want to invoke subagents (via the `loom-invoke` shim).
 * That path is in `src/server/server.ts` + `src/cli/loom-invoke.ts`.
 *
 * The subagent's own [sandbox] applies — children do NOT inherit the
 * parent's ceiling. That falls out of just calling runAgent() on the
 * child manifest.
 */

import { connectAcpUrl } from "../acp/client.js";
import { ResolutionError } from "../errors.js";
import { runAgent, type RunAgentOptions } from "../sdk/run-agent.js";
import type { ResolvedSubagent } from "../manifest/resolver.js";
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
 * Entries are keyed by name (the model uses this name as the `scope`
 * argument). Whatever skills declared is what's invokable — there is no
 * separate agent-level subagent ceiling.
 */
export class SubagentRegistry {
  private readonly byName = new Map<string, SubagentRegistryEntry>();

  constructor(entries: Iterable<SubagentRegistryEntry & { name: string }>) {
    for (const e of entries) {
      this.byName.set(e.name, { ref: e.ref, skill: e.skill });
    }
  }

  /** All known names. */
  names(): string[] {
    return [...this.byName.keys()];
  }

  /** Resolve a scope; throws if unknown. */
  resolve(scope: string): SubagentRegistryEntry {
    const entry = this.byName.get(scope);
    if (!entry) {
      throw new ResolutionError(
        `Unknown subagent scope '${scope}'. Available: ${this.names().join(", ") || "(none)"}`,
      );
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
    "Run another Loom agent (a subagent) and return its final assistant message.";
  public readonly inputSchema = SPAWN_SCHEMA;

  constructor(
    private readonly registry: SubagentRegistry,
    private readonly options: { runOptions?: RunAgentOptions } = {},
  ) {}

  async execute(
    input: unknown,
    _secrets: Record<string, string>,
  ): Promise<ToolResult> {
    const params = (input ?? {}) as { scope?: string; prompt?: string };
    if (typeof params.scope !== "string" || typeof params.prompt !== "string") {
      return {
        content: "spawn_subagent: 'scope' and 'prompt' are required strings",
        isError: true,
      };
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
      return {
        content: `spawn_subagent error: ${(e as Error).message}`,
        isError: true,
      };
    }
  }

  private async runOne(
    entry: SubagentRegistryEntry,
    prompt: string,
  ): Promise<string> {
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
    const manifestPath = ref.kind === "path" ? ref.path : ref.resolvedPath;
    const sub = await runAgent(manifestPath, this.options.runOptions ?? {});
    try {
      await sub.prompt(prompt);
      return await lastAgentMessage(sub.session);
    } finally {
      await sub.close();
    }
  }
}
