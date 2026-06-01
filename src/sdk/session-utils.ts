import type { SessionUpdate, StopReason } from "../types/acp.js";
import type {
  Harness,
  Runtime,
  SummariseArgs,
  ToolCall,
  ToolDescriptor,
  ToolResult,
} from "../types/interfaces.js";

export async function summariseViaRun(
  harness: Harness,
  args: SummariseArgs,
): Promise<string> {
  const collected: string[] = [];
  const synthetic = new SyntheticRuntime({
    events: args.events,
    systemPrompt: args.systemPrompt,
    abortSignal: args.abortSignal ?? new AbortController().signal,
    onAgentText: (text) => collected.push(text),
  });
  synthetic.appendInstruction(args.instruction);
  await harness.run(synthetic);
  return collected.join("");
}

export async function summarise(
  harness: Harness,
  args: SummariseArgs,
): Promise<string> {
  if (harness.summarise) {
    return await harness.summarise(args);
  }
  return await summariseViaRun(harness, args);
}

interface SyntheticRuntimeOptions {
  events: SessionUpdate[];
  systemPrompt: string;
  abortSignal: AbortSignal;
  onAgentText: (text: string) => void;
}

class SyntheticRuntime implements Runtime {
  public readonly abortSignal: AbortSignal;
  private readonly opts: SyntheticRuntimeOptions;
  private readonly extra: SessionUpdate[] = [];

  constructor(opts: SyntheticRuntimeOptions) {
    this.opts = opts;
    this.abortSignal = opts.abortSignal;
  }

  appendInstruction(text: string): void {
    this.extra.push({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
    });
  }

  async getEvents(): Promise<SessionUpdate[]> {
    return [...this.opts.events, ...this.extra];
  }

  async update(update: SessionUpdate): Promise<void> {
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
    ) {
      this.opts.onAgentText(update.content.text);
    }
  }

  systemPrompt(): string {
    return this.opts.systemPrompt;
  }

  systemPromptCore(): string {
    return this.opts.systemPrompt;
  }

  listTools(): ToolDescriptor[] {
    return [];
  }

  async executeTool(_call: ToolCall): Promise<ToolResult> {
    return {
      content:
        "summarise() is a tool-free turn; the model cannot call tools here",
      isError: true,
    };
  }

  async emitToolResult(): Promise<void> {}
}

export type { StopReason };
