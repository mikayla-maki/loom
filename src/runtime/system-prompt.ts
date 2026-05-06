/**
 * System prompt assembly.
 *
 * Loom owns the system prompt. Each turn, the runtime composes a single
 * string from three sources:
 *   1. Runtime-owned (structural): the skill/tool catalog
 *   2. Manifest-owned (semantic): [agent].system_prompt content
 *   3. Per-turn (dynamic): current date and any other context Loom injects
 *
 * Harness extensions consume the final string via runtime.systemPrompt().
 * They MAY override by reading components separately (identity(),
 * listSkills()) — this is opt-out, not the default.
 */

import type { SkillDescriptor, ToolDescriptor } from "../types/interfaces.js";

export interface SystemPromptInputs {
  /** The resolved [agent].system_prompt content (manifest-owned core). */
  core: string;
  skills: SkillDescriptor[];
  tools: ToolDescriptor[];
  /** Per-turn context (e.g. now, agent name, agent description). */
  agentName: string;
  agentDescription?: string;
  now?: Date;
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

  // 1b. Inlined skills — flagged as part of the core. Most importantly: the
  // auto-loaded `core` builtin skill, which lists the always-on file/shell
  // tools and how to use them. Rendered as raw body so the model treats
  // them as ambient guidance, not a discrete capability to invoke.
  const inlineSkills = inputs.skills.filter((s) => s.inlineInSystemPrompt);
  for (const sk of inlineSkills) {
    if (sk.body.trim()) parts.push(sk.body.trim());
  }

  // 2. Capabilities (structural, runtime-owned). Excludes inlined skills.
  const visibleSkills = inputs.skills.filter((s) => !s.inlineInSystemPrompt);
  if (visibleSkills.length > 0) {
    const lines: string[] = ["# Available Skills"];
    for (const sk of visibleSkills) {
      lines.push(`## ${sk.name}\n${sk.description}`);
      if (sk.toolNames.length > 0) {
        lines.push(`Tools: ${sk.toolNames.join(", ")}`);
      }
      if (sk.body.trim()) {
        lines.push(sk.body.trim());
      }
    }
    parts.push(lines.join("\n\n"));
  }

  if (inputs.tools.length > 0) {
    const lines: string[] = ["# Tool Reference"];
    for (const t of inputs.tools) {
      lines.push(`- \`${t.name}\` — ${t.description}`);
    }
    parts.push(lines.join("\n"));
  }

  // 3. Per-turn dynamic context.
  const dyn: string[] = ["# Context"];
  const now = inputs.now ?? new Date();
  dyn.push(`Current date: ${now.toISOString()}`);
  parts.push(dyn.join("\n"));

  return parts.join("\n\n---\n\n").trim() + "\n";
}
