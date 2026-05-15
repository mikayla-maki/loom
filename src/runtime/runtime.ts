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
    // Two updates leave this method: one to the session (event log),
    // one to the update sink (ACP client).
    //
    // The only field that differs between them is `content`. The
    // session always gets the model-facing text block; the client
    // gets `display.content` when set (terminal embeds, diff blocks,
    // other client-renderable shapes that aren't replayable by the
    // model). Everything else — `title`, `kind`, `locations`,
    // `rawOutput` — is shared metadata that both audiences want:
    //   - clients render `rawOutput` in raw-output inspectors and
    //     use `title`/`kind`/`locations` for affordances;
    //   - the harness reads `rawOutput` back on replay for tools
    //     whose API expects structured payloads in subsequent turns
    //     (Anthropic server tools — `web_search_tool_result` carries
    //     `encrypted_content` the model needs to re-cite).
    //
    // Sessions are free to drop / transform / compact this payload
    // like any other event field; large `rawOutput` blobs go with
    // their parent `tool_call_update` when a compacting session
    // summarises old turns.
    const display = args.display;
    const sharedMeta = {
      ...(display?.title ? { title: display.title } : {}),
      ...(display?.kind ? { kind: display.kind } : {}),
      ...(display?.locations ? { locations: display.locations } : {}),
      ...(display?.rawOutput !== undefined
        ? { rawOutput: display.rawOutput }
        : {}),
    };
    const modelTextContent = [
      {
        type: "content" as const,
        content: { type: "text" as const, text: args.modelContent },
      },
    ];
    const sessionUpdate: SessionUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: args.toolCallId,
      status: args.status,
      content: modelTextContent,
      ...sharedMeta,
    };
    await Promise.resolve(this.opts.session.push?.(sessionUpdate) ?? []);

    const clientUpdate: SessionUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: args.toolCallId,
      status: args.status,
      content: display?.content ?? modelTextContent,
      ...sharedMeta,
    };
    this.opts.updateSink.emit(clientUpdate);
  }
}
