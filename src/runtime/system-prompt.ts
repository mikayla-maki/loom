/**
 * System prompt assembly.
 *
 * Loom owns the system prompt. Each turn, the runtime composes a single
 * string from three sources:
 *   1. Manifest-owned (identity): `[agent].system_prompt` content (the
 *      core).
 *   2. Runtime-owned (structural): the tool reference.
 *   3. Session-owned (identity — retrieved memories, etc.): the section
 *      the Session contributes via `systemPromptSection()`.
 *
 * Order is: core → tools → session section. The session goes last so
 * it lands closest to the conversation history — retrieved memories
 * then sit in the model's freshest attention.
 *
 * The runtime deliberately does NOT inject ambient context like the
 * current date. "What does the model need to know about the wall
 * clock?" is an application-specific question — some agents want a
 * date, some want a precise timestamp, most want neither. Agents
 * that need it should put it in their `[agent].system_prompt` (for
 * a static answer) or contribute a session section (for a dynamic
 * one). Keeping it out of the runtime also means the assembled
 * prompt is byte-stable across turns, which is what implicit
 * prompt caching keys on.
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
  /** Identity fallbacks used when `core` is empty. */
  agentName: string;
  agentDescription?: string;
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

  // 3. Session-contributed section (memory, scoped instructions, etc.).
  // Goes last so it's closest to the conversation history — the model's
  // recency bias works in our favour for fresh memories.
  if (inputs.sessionSection && inputs.sessionSection.trim().length > 0) {
    const lines: string[] = ["# Session"];
    lines.push(inputs.sessionSection.trim());
    parts.push(lines.join("\n"));
  }

  return parts.join("\n\n---\n\n").trim() + "\n";
}
