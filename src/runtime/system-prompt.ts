import type { ToolDescriptor } from "../types/interfaces.js";

export interface SystemPromptInputs {
  core: string;
  tools: ToolDescriptor[];
  agentName: string;
  agentDescription?: string;
  sessionSection?: string;
}

export function assembleSystemPrompt(inputs: SystemPromptInputs): string {
  const parts: string[] = [];

  if (inputs.core.trim().length > 0) {
    parts.push(inputs.core.trim());
  } else {
    parts.push(
      `You are ${inputs.agentName}${
        inputs.agentDescription ? ` — ${inputs.agentDescription}` : ""
      }.`,
    );
  }

  if (inputs.tools.length > 0) {
    const lines: string[] = ["# Tool Reference"];
    for (const t of inputs.tools) {
      lines.push(`- \`${t.name}\` — ${t.description}`);
    }
    parts.push(lines.join("\n"));
  }

  // Session section goes last so fresh memories sit closest to the conversation history.
  if (inputs.sessionSection && inputs.sessionSection.trim().length > 0) {
    const lines: string[] = ["# Session"];
    lines.push(inputs.sessionSection.trim());
    parts.push(lines.join("\n"));
  }

  return parts.join("\n\n---\n\n").trim() + "\n";
}
