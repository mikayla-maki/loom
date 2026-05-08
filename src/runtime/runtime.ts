/**
 * RuntimeImpl — what the harness calls during one turn. New instance per
 * prompt(); reads live state from the shared AgentState, emits updates to
 * the shared UpdateSink.
 */

import { randomUUID } from "node:crypto";

import type {
  Runtime,
  Session,
  SkillDescriptor,
  ToolCall,
  ToolDescriptor,
  ToolResult,
} from "../types/interfaces.js";
import type { SessionUpdate } from "../types/acp.js";

import type { AgentState } from "./agent-state.js";
import { assembleSystemPrompt } from "./system-prompt.js";
import type { UpdateSink } from "./update-sink.js";
import { pathForSkill } from "./skill-paths.js";

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

  getEvents(from?: number, to?: number): Promise<SessionUpdate[]> {
    return this.opts.session.getEvents(from, to);
  }

  async update(update: SessionUpdate): Promise<void> {
    await this.opts.session.append(update);
    this.opts.updateSink.emit(update);
  }

  systemPrompt(): string {
    return assembleSystemPrompt({
      core: this.opts.systemPromptCore,
      skills: this.listSkills(),
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

  listSkills(): SkillDescriptor[] {
    return this.opts.state.skills.map((s) => ({
      name: s.name ?? "",
      description: s.description,
      body: s.body ?? "",
      toolNames: Object.keys(s.requires ?? {}),
      path: pathForSkill(s),
    }));
  }

  listTools(): ToolDescriptor[] {
    return this.opts.state.toolTable.list();
  }

  executeTool(call: ToolCall): Promise<ToolResult> {
    if (!call.id) call.id = randomUUID();
    return this.opts.state.toolTable.execute(call);
  }
}
