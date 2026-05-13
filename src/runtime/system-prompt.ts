/**
 * System prompt assembly.
 *
 * Loom owns the system prompt. Each turn, the runtime composes a single
 * string from three sources:
 *   1. Manifest-owned (identity): `[agent].system_prompt` content (the
 *      core).
 *   2. Runtime-owned (structural): the tool reference.
 *   3. Ambient context: current date and other slow-moving facts.
 *      Deliberately coarse-grained (date-only, not timestamp) so the
 *      assembled prompt stays byte-stable across a day and implicit
 *      prompt caching can hit. Per-event timing lives on
 *      `PersistedUpdate` and never reaches the wire.
 *   4. Session-owned (identity — retrieved memories, etc.): the section
 *      the Session contributes via `systemPromptSection()`.
 *
 * Order is: core → tools → ambient context → session section. The
 * session goes last so it lands closest to the conversation history
 * — retrieved memories then sit in the model's freshest attention.
 *
 * Harness extensions consume the final string via runtime.systemPrompt().
 * They MAY override by reading components separately
 * (systemPromptCore(), listTools()) — this is opt-out, not the
 * default.
 */

import type { ToolDescriptor } from "../types/interfaces.js";

export interface SystemPromptInputs {
  /** The resolved [agent].system_prompt content (manifest-owned core). */
  core: string;
  tools: ToolDescriptor[];
  /** Per-turn context (e.g. now, agent name, agent description). */
  agentName: string;
  agentDescription?: string;
  now?: Date;
  /**
   * Section contributed by the active Session. Resolved at turn start
   * (so memory implementations can pull from the latest user message).
   * Empty/undefined → nothing is added.
   */
  sessionSection?: string;
}

export function assembleSystemPrompt(inputs: SystemPromptInputs): string {
  const parts: string[] = [];

  // 1. Manifest-owned core ([agent].system_prompt).
  if (inputs.core.trim().length > 0) {
    parts.push(inputs.core.trim());
  } else {
    parts.push(
      `You are ${inputs.agentName}${
        inputs.agentDescription ? ` — ${inputs.agentDescription}` : ""
      }.`,
    );
  }

  // 2. Tool reference.
  if (inputs.tools.length > 0) {
    const lines: string[] = ["# Tool Reference"];
    for (const t of inputs.tools) {
      lines.push(`- \`${t.name}\` — ${t.description}`);
    }
    parts.push(lines.join("\n"));
  }

  // 3. Ambient context.
  //
  // Date-only (YYYY-MM-DD), deliberately not down-to-the-second. The
  // system prompt is the longest stable prefix of every request and
  // is what implicit prompt caching keys on; a full ISO timestamp
  // here would change every turn and invalidate the cache for every
  // call. Per-event timestamps DO live on `PersistedUpdate` for
  // observability/replay, but the harness's `eventsToMessages`
  // pipeline doesn't include them in what it sends to the model —
  // so the request body itself stays stable across a day.
  const dyn: string[] = ["# Context"];
  const now = inputs.now ?? new Date();
  dyn.push(`Current date: ${now.toISOString().slice(0, 10)}`);
  parts.push(dyn.join("\n"));

  // 4. Session-contributed section (memory, scoped instructions, etc.).
  // Goes last so it's closest to the conversation history — the model's
  // recency bias works in our favour for fresh memories.
  if (inputs.sessionSection && inputs.sessionSection.trim().length > 0) {
    const lines: string[] = ["# Session"];
    lines.push(inputs.sessionSection.trim());
    parts.push(lines.join("\n"));
  }

  return parts.join("\n\n---\n\n").trim() + "\n";
}
