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
  ContentBlock,
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
    return Promise.resolve(this.opts.session.pull?.([]) ?? []);
  }

  async update(update: SessionUpdate): Promise<void> {
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
    modelContent: string | ContentBlock[];
    display?: ToolDisplay;
  }): Promise<void> {
    // Session gets model-facing content; client gets display.content when set. Both
    // share rawOutput so replay can re-cite server-tool payloads (e.g. web_search).
    const display = args.display;
    const sharedMeta = {
      ...(display?.title ? { title: display.title } : {}),
      ...(display?.kind ? { kind: display.kind } : {}),
      ...(display?.locations ? { locations: display.locations } : {}),
      ...(display?.rawOutput !== undefined
        ? { rawOutput: display.rawOutput }
        : {}),
    };
    // A string stays a single text entry (byte-identical to the historical
    // shape); block arrays map 1:1 so replay preserves rich content.
    const modelTextContent =
      typeof args.modelContent === "string"
        ? [
            {
              type: "content" as const,
              content: { type: "text" as const, text: args.modelContent },
            },
          ]
        : args.modelContent.map((block) => ({
            type: "content" as const,
            content: block,
          }));
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
