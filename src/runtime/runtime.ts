/**
 * RuntimeImpl — what the harness calls during one turn. New instance per
 * prompt(); reads live state from the shared AgentState, emits updates to
 * the shared UpdateSink.
 */

import { randomUUID } from "node:crypto";

import type {
  Runtime,
  Session,
  ToolCall,
  ToolDescriptor,
  ToolDisplay,
  ToolResult,
} from "../types/interfaces.js";
import type {
  SessionUpdate,
  ToolCallId,
  ToolCallStatus,
} from "../types/acp.js";

import type { AgentState } from "./agent-state.js";
import { assembleSystemPrompt } from "./system-prompt.js";
import type { UpdateSink } from "./update-sink.js";

export interface RuntimeImplOptions {
  session: Session;
  state: AgentState;
  systemPromptCore: string;
  updateSink: UpdateSink;
  agentName: string;
  agentDescription?: string;
  abortSignal: AbortSignal;
  /**
   * Pre-resolved section contributed by the session for this turn. The
   * caller (RunningAgentImpl.prompt) awaits any async
   * `Session.systemPromptSection()` before constructing the runtime, so
   * `systemPrompt()` here stays sync.
   */
  sessionSection?: string;
  /** Test hook: deterministic "now" used in system-prompt assembly. */
  now?: () => Date;
}

export class RuntimeImpl implements Runtime {
  public readonly abortSignal: AbortSignal;
  private readonly opts: RuntimeImplOptions;

  constructor(opts: RuntimeImplOptions) {
    this.opts = opts;
    this.abortSignal = opts.abortSignal;
  }

  getEvents(): Promise<SessionUpdate[]> {
    // Pull the session's view of the context window. Composed
    // sessions handle the chain internally.
    return Promise.resolve(this.opts.session.pull?.([]) ?? []);
  }

  async update(update: SessionUpdate): Promise<void> {
    // Push to the session (storage / transformation), then fan out to
    // observers. Update sink sees the original event regardless of
    // any chain-internal transforms.
    await Promise.resolve(this.opts.session.push?.(update) ?? [update]);
    this.opts.updateSink.emit(update);
  }

  systemPrompt(): string {
    return assembleSystemPrompt({
      core: this.opts.systemPromptCore,
      tools: this.listTools(),
      agentName: this.opts.agentName,
      ...(this.opts.agentDescription
        ? { agentDescription: this.opts.agentDescription }
        : {}),
      ...(this.opts.sessionSection
        ? { sessionSection: this.opts.sessionSection }
        : {}),
      now: this.opts.now ? this.opts.now() : new Date(),
    });
  }

  systemPromptCore(): string {
    return this.opts.systemPromptCore;
  }

  listTools(): ToolDescriptor[] {
    return this.opts.state.toolTable.list();
  }

  executeTool(call: ToolCall): Promise<ToolResult> {
    if (!call.id) call.id = randomUUID();
    return this.opts.state.toolTable.execute(call);
  }

  async emitToolResult(args: {
    toolCallId: ToolCallId;
    status: ToolCallStatus;
    modelContent: string;
    display?: ToolDisplay;
  }): Promise<void> {
    // ── Session record: text-only, what the model replays ──
    // The harness's `eventsToMessages` (or equivalent) reads back
    // these stored updates and builds tool_result blocks for the
    // next API call. We always wrap the model-facing string as a
    // single text block so that extraction is trivial and the
    // model never reads an empty result — even if `display` carried
    // a terminal embed or a diff that an ACP client would render
    // but the model wouldn't understand.
    const sessionUpdate: SessionUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: args.toolCallId,
      status: args.status,
      content: [
        {
          type: "content",
          content: { type: "text", text: args.modelContent },
        },
      ],
    };
    await Promise.resolve(this.opts.session.push?.(sessionUpdate) ?? []);

    // ── Client display: rich, what the IDE/REPL renders ──
    // Falls back to the session update's text block when no
    // `display` was provided (preserves the current single-text
    // behaviour for tools that don't opt in to rich rendering).
    const display = args.display;
    const clientUpdate: SessionUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: args.toolCallId,
      status: args.status,
      content: display?.content ?? sessionUpdate.content,
      ...(display?.title ? { title: display.title } : {}),
      ...(display?.kind ? { kind: display.kind } : {}),
      ...(display?.locations ? { locations: display.locations } : {}),
      ...(display?.rawOutput !== undefined
        ? { rawOutput: display.rawOutput }
        : {}),
    };
    this.opts.updateSink.emit(clientUpdate);
  }
}
