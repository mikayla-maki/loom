/**
 * Session-side utilities.
 *
 * Sessions get the agent's harness via the per-turn `Agent` ref
 * (passed to `prepareTurn` / `systemPromptSection`) and may want to
 * drive a one-shot model call (compaction, periodic reflection, memory
 * retrieval). Two functions live here:
 *
 *   - `summariseViaRun(harness, args)` — drive a tool-free turn through
 *     `harness.run()` against a synthetic Runtime. The default fallback
 *     when the harness doesn't implement `summarise` natively.
 *
 *   - `summarise(harness, args)` — convenience: native `summarise` if
 *     the harness implements it, `summariseViaRun` otherwise. This is
 *     what most session code should call.
 *
 * The synthetic runtime exposes the supplied events and prompt; lists
 * no tools (so the model can't dispatch); collects
 * agent_message_chunks; drops everything else (we don't fan
 * compaction-internals out to the live UpdateSink).
 */

import type { SessionUpdate, StopReason } from "../types/acp.js";
import type {
  Harness,
  Runtime,
  SummariseArgs,
  ToolCall,
  ToolDescriptor,
  ToolResult,
} from "../types/interfaces.js";

/**
 * Synthesise `Harness.summarise` from `Harness.run`.
 *
 * Used as the fallback when a harness doesn't implement `summarise`
 * natively. Sessions can also call this directly when they want to be
 * explicit about "I want the run-driven path even if a native one is
 * available."
 */
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
  // Inject the instruction as the final user message in the synthetic
  // history so the model sees it as the last thing said.
  synthetic.appendInstruction(args.instruction);
  await harness.run(synthetic);
  return collected.join("");
}

/**
 * Summarise using the harness's native `summarise` if available, falling
 * back to `summariseViaRun` otherwise. The recommended call site for
 * session-side compaction / memory code.
 */
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

  /**
   * Append a synthetic `user_message_chunk` containing the instruction.
   * Done after construction so callers can phrase the instruction
   * however they like.
   */
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
    // Everything else (tool_call, stop, plan, etc.) is dropped.
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
    // Defensive: harness shouldn't dispatch tools when listTools()=[].
    return {
      content:
        "summarise() is a tool-free turn; the model cannot call tools here",
      isError: true,
    };
  }

  async emitToolResult(): Promise<void> {
    // No-op. `summarise()` is a tool-free turn (see `executeTool`),
    // so no harness should ever call this. We satisfy the interface
    // contract without dragging session/sink wiring into the synthetic
    // runtime.
  }
}

// Re-export StopReason so consumers can write summarise wrappers.
export type { StopReason };
