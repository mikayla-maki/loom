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
import type { SessionUpdate } from "../types/acp.js";
import type { SkillManifest } from "../types/manifest.js";

import { assembleSystemPrompt } from "./system-prompt.js";
import type { ToolTable } from "./tool-table.js";
import type { UpdateSink } from "./update-sink.js";

export interface RuntimeImplOptions {
  session: Session;
  toolTable: ToolTable;
  skills: SkillManifest[];
  identity: string;
  updateSink: UpdateSink;
  agentName: string;
  agentDescription?: string;
  abortSignal: AbortSignal;
  /** For testing: deterministic 'now' / system-prompt timestamp. */
  now?: () => Date;
}

export class RuntimeImpl implements Runtime {
  public readonly abortSignal: AbortSignal;
  private readonly opts: RuntimeImplOptions;
  private cachedSystemPrompt: string | null = null;

  constructor(opts: RuntimeImplOptions) {
    this.opts = opts;
    this.abortSignal = opts.abortSignal;
  }

  async getEvents(from?: number, to?: number): Promise<SessionUpdate[]> {
    return this.opts.session.getEvents(from, to);
  }

  async update(update: SessionUpdate): Promise<void> {
    await this.opts.session.append(update);
    this.opts.updateSink.emit(update);
  }

  systemPrompt(): string {
    if (this.cachedSystemPrompt !== null) return this.cachedSystemPrompt;
    const skills = this.listSkills();
    const tools = this.listTools();
    const prompt = assembleSystemPrompt({
      identity: this.opts.identity,
      skills,
      tools,
      agentName: this.opts.agentName,
      ...(this.opts.agentDescription ? { agentDescription: this.opts.agentDescription } : {}),
      now: this.opts.now ? this.opts.now() : new Date(),
    });
    this.cachedSystemPrompt = prompt;
    return prompt;
  }

  identity(): string {
    return this.opts.identity;
  }

  listSkills(): SkillDescriptor[] {
    return this.opts.skills.map((s) => ({
      name: s.name,
      description: s.description,
      body: s.body,
      toolNames: Object.keys(s.requires),
    }));
  }

  listTools(): ToolDescriptor[] {
    return this.opts.toolTable.list();
  }

  async executeTool(call: ToolCall): Promise<ToolResult> {
    if (!call.id) call.id = randomUUID();
    return this.opts.toolTable.execute(call);
  }
}
