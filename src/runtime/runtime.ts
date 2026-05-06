/**
 * RuntimeImpl — the runtime face of Glass.
 *
 * One instance per turn. Composes the system prompt, exposes session reads
 * and update emission, fans out updates to subscribers, and serves tool
 * execution to the harness.
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
import type {
  PermissionHandler,
  PermissionRequest,
  PermissionResult,
} from "../types/permissions.js";
import { denyAllPermissionHandler } from "../types/permissions.js";
import type { SessionUpdate } from "../types/acp.js";

import type { AgentState } from "./agent-state.js";
import { assembleSystemPrompt } from "./system-prompt.js";
import type { UpdateSink } from "./update-sink.js";

export interface RuntimeImplOptions {
  session: Session;
  state: AgentState;
  /** Resolved value of [agent].system_prompt. */
  systemPromptCore: string;
  updateSink: UpdateSink;
  agentName: string;
  agentDescription?: string;
  abortSignal: AbortSignal;
  /** Optional handler for capability-expansion + tool consent. Defaults to deny-all. */
  permissionHandler?: PermissionHandler;
  /** For testing: deterministic 'now' / system-prompt timestamp. */
  now?: () => Date;
}

export class RuntimeImpl implements Runtime {
  public readonly abortSignal: AbortSignal;
  private readonly opts: RuntimeImplOptions;
  private readonly permissionHandler: PermissionHandler;
  /**
   * The system prompt is cached for the duration of one model call but
   * recomputed when state changes (e.g. add_skill mutates AgentState).
   * We track this with a snapshot of skills+tools length: if either grows,
   * the cache is dropped.
   */
  private cachedSystemPrompt: string | null = null;
  private cacheSnapshot: { skills: number; tools: number } | null = null;

  constructor(opts: RuntimeImplOptions) {
    this.opts = opts;
    this.abortSignal = opts.abortSignal;
    this.permissionHandler = opts.permissionHandler ?? denyAllPermissionHandler;
  }

  async getEvents(from?: number, to?: number): Promise<SessionUpdate[]> {
    return this.opts.session.getEvents(from, to);
  }

  async update(update: SessionUpdate): Promise<void> {
    await this.opts.session.append(update);
    this.opts.updateSink.emit(update);
  }

  systemPrompt(): string {
    const skillsLen = this.opts.state.skills.length;
    const toolsLen = this.opts.state.toolTable.list().length;
    if (
      this.cachedSystemPrompt !== null &&
      this.cacheSnapshot &&
      this.cacheSnapshot.skills === skillsLen &&
      this.cacheSnapshot.tools === toolsLen
    ) {
      return this.cachedSystemPrompt;
    }
    const skills = this.listSkills();
    const tools = this.listTools();
    const prompt = assembleSystemPrompt({
      core: this.opts.systemPromptCore,
      skills,
      tools,
      agentName: this.opts.agentName,
      ...(this.opts.agentDescription ? { agentDescription: this.opts.agentDescription } : {}),
      now: this.opts.now ? this.opts.now() : new Date(),
    });
    this.cachedSystemPrompt = prompt;
    this.cacheSnapshot = { skills: skillsLen, tools: toolsLen };
    return prompt;
  }

  systemPromptCore(): string {
    return this.opts.systemPromptCore;
  }

  listSkills(): SkillDescriptor[] {
    return this.opts.state.skills.map((s) => ({
      name: s.name,
      description: s.description,
      body: s.body,
      toolNames: Object.keys(s.requires),
      ...(s.inlineInSystemPrompt ? { inlineInSystemPrompt: true } : {}),
    }));
  }

  listTools(): ToolDescriptor[] {
    return this.opts.state.toolTable.list();
  }

  async executeTool(call: ToolCall): Promise<ToolResult> {
    if (!call.id) call.id = randomUUID();
    return this.opts.state.toolTable.execute(call);
  }

  async requestPermission(req: PermissionRequest): Promise<PermissionResult> {
    return await this.permissionHandler(req);
  }
}
