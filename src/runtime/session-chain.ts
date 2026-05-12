/**
 * Composition primitive for session chains.
 *
 * Pipelines N `Session`s in outer-to-inner order. The chain protocol is
 * the Session interface itself:
 *
 *   - `push(event)` flows top-to-bottom. Each layer may transform,
 *     drop, or fan-out the event before the next layer sees it.
 *   - `pull(below)` flows bottom-to-top. Each layer receives what the
 *     layers below it produced and may rewrite/replace it.
 *
 * Other hooks (`prepareTurn`, `systemPromptSection`, `tools`,
 * `trustedPaths`, `dependencies`, `close`) are aggregated across all
 * children.
 *
 * Not public API: the SDK exposes chains via `SessionSpec[]` on the
 * manifest's `session` field. `ChainedSession` is the runtime's
 * composition vehicle, not a user-facing class.
 */

import type {
  Agent,
  Session,
  Tool,
  ToolConfig,
  ToolRef,
  TrustedPath,
} from "../types/interfaces.js";
import type { SessionUpdate } from "../types/acp.js";
import type { AgentManifest, CapabilitySet } from "../types/manifest.js";

export class ChainedSession implements Session {
  constructor(private readonly children: readonly Session[]) {}

  async push(event: SessionUpdate): Promise<SessionUpdate[]> {
    let events: SessionUpdate[] = [event];
    for (const child of this.children) {
      const out: SessionUpdate[] = [];
      for (const e of events) {
        const forwarded = (await child.push?.(e)) ?? [e];
        out.push(...forwarded);
      }
      events = out;
      if (events.length === 0) break;
    }
    return events;
  }

  async pull(below: SessionUpdate[]): Promise<SessionUpdate[]> {
    let events = below;
    for (const child of [...this.children].reverse()) {
      events = (await child.pull?.(events)) ?? events;
    }
    return events;
  }

  async prepareTurn(agent: Agent): Promise<void> {
    for (const c of this.children) await c.prepareTurn?.(agent);
  }

  async systemPromptSection(agent: Agent): Promise<string> {
    const parts: string[] = [];
    for (const c of this.children) {
      const part = await c.systemPromptSection?.(agent);
      if (part) parts.push(part);
    }
    return parts.join("\n\n");
  }

  async tools(): Promise<ToolRef[]> {
    const all: ToolRef[] = [];
    for (const c of this.children) {
      const ts = (await c.tools?.()) ?? [];
      all.push(...ts);
    }
    return all;
  }

  /**
   * Walk children in declaration order; the first one whose
   * `resolveTool` returns a non-null `Tool` wins. This lets a chain
   * combine layers that contribute tool names without owning them
   * (e.g. `SkillsSession` → native) with layers that DO own the
   * implementation (e.g. a memory-tagging session). Returns `null`
   * when no child claims the name, and the runtime falls back to
   * native + SDK Tools.
   */
  async resolveTool(
    name: string,
    config: ToolConfig,
    agent: Agent,
    capabilities: CapabilitySet | undefined,
  ): Promise<Tool | null> {
    for (const child of this.children) {
      if (!child.resolveTool) continue;
      const t = await Promise.resolve(
        child.resolveTool(name, config, agent, capabilities),
      );
      if (t) return t;
    }
    return null;
  }

  async trustedPaths(): Promise<TrustedPath[]> {
    // Concat without dedup; the audit/consuming layer merges duplicates.
    const all: TrustedPath[] = [];
    for (const c of this.children) {
      const ps = (await c.trustedPaths?.()) ?? [];
      all.push(...ps);
    }
    return all;
  }

  get dependencies(): { subagents?: AgentManifest[] } {
    const subagents: AgentManifest[] = [];
    for (const c of this.children) {
      subagents.push(...(c.dependencies?.subagents ?? []));
    }
    return subagents.length > 0 ? { subagents } : {};
  }

  async close(): Promise<void> {
    for (const c of this.children) await c.close?.();
  }
}
