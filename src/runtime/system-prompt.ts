/**
 * System prompt assembly.
 *
 * Glass owns the system prompt. Each turn, the runtime composes a single
 * string from three sources:
 *   1. Runtime-owned (structural): the skill/tool catalog
 *   2. Manifest-owned (semantic): [agent].identity content
 *   3. Per-turn (dynamic): current date and any other context Glass injects
 *
 * Harness extensions consume the final string via runtime.systemPrompt().
 * They MAY override by reading components separately (identity(),
 * listSkills()) — this is opt-out, not the default.
 */

import type { SkillDescriptor, ToolDescriptor } from "../types/interfaces.js";

export interface SystemPromptInputs {
  identity: string;
  skills: SkillDescriptor[];
  tools: ToolDescriptor[];
  /** Per-turn context (e.g. now, agent name, agent description). */
  agentName: string;
  agentDescription?: string;
  now?: Date;
}

export function assembleSystemPrompt(inputs: SystemPromptInputs): string {
  const parts: string[] = [];

  // 1. Identity (semantic, manifest-owned).
  if (inputs.identity.trim().length > 0) {
    parts.push("# Identity\n\n" + inputs.identity.trim());
  } else {
    parts.push(
      `# Identity\n\nYou are ${inputs.agentName}${
        inputs.agentDescription ? ` — ${inputs.agentDescription}` : ""
      }.`,
    );
  }

  // 2. Capabilities (structural, runtime-owned).
  if (inputs.skills.length > 0) {
    const lines: string[] = ["# Available Skills"];
    for (const sk of inputs.skills) {
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
