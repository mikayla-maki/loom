/**
 * RunningAgentImpl — the SDK handle returned to clients.
 *
 * Lifecycle:
 *   - prompt(text) appends a user_message_chunk + runs ONE turn to completion.
 *   - cancel() aborts the in-flight turn (the harness should observe the
 *     AbortSignal and stop promptly).
 *   - updates() returns an async iterable that yields every SessionUpdate
 *     emitted during turns (and any that the runtime emits out-of-band).
 *   - close() releases resources (sessions, sink subscribers).
 */

import type { SessionUpdate, StopReason } from "../types/acp.js";
import type { Harness, Runtime, Session } from "../types/interfaces.js";

import { RuntimeImpl } from "../runtime/runtime.js";
import type { ToolTable } from "../runtime/tool-table.js";
import type { UpdateSink } from "../runtime/update-sink.js";
import type { ResolvedAgent } from "../manifest/resolver.js";
import type { SkillManifest } from "../types/manifest.js";

export interface RunningAgent {
  prompt(text: string): Promise<StopReason>;
  cancel(): Promise<void>;
  updates(opts?: { capacity?: number }): AsyncIterableIterator<SessionUpdate>;
  readonly session: Session;
  readonly resolved: ResolvedAgent;
  /** Resolved secret values (for diagnostics; never logged). */
  readonly secretNames: string[];
  close(): Promise<void>;
}

interface RunningAgentImplOptions {
  resolved: ResolvedAgent;
  secrets: Record<string, string>;
  session: Session;
  harness: Harness;
  toolTable: ToolTable;
  skills: SkillManifest[];
  updateSink: UpdateSink;
  now?: () => Date;
}

export class RunningAgentImpl implements RunningAgent {
  public readonly session: Session;
  public readonly resolved: ResolvedAgent;
  public readonly secretNames: string[];

  private readonly harness: Harness;
  private readonly toolTable: ToolTable;
  private readonly skills: SkillManifest[];
  private readonly updateSink: UpdateSink;
  private readonly now: (() => Date) | undefined;

  private currentAbortCtl: AbortController | null = null;
  private inflight: Promise<StopReason> | null = null;
  private closed = false;

  constructor(opts: RunningAgentImplOptions) {
    this.resolved = opts.resolved;
    this.session = opts.session;
    this.harness = opts.harness;
    this.toolTable = opts.toolTable;
    this.skills = opts.skills;
    this.updateSink = opts.updateSink;
    this.secretNames = Object.keys(opts.secrets);
    this.now = opts.now;
  }

  async prompt(text: string): Promise<StopReason> {
    if (this.closed) throw new Error("Agent has been closed");
    if (this.inflight) {
      // Serialise turns: wait for the previous one to finish.
      await this.inflight.catch(() => undefined);
    }
    const userUpdate: SessionUpdate = {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
    };
    await this.session.append(userUpdate);
    this.updateSink.emit(userUpdate);

    const ctl = new AbortController();
    this.currentAbortCtl = ctl;
    const runtime: Runtime = new RuntimeImpl({
      session: this.session,
      toolTable: this.toolTable,
      skills: this.skills,
      identity: this.resolved.identity,
      updateSink: this.updateSink,
      agentName: this.resolved.manifest.agent.name,
      ...(this.resolved.manifest.agent.description
        ? { agentDescription: this.resolved.manifest.agent.description }
        : {}),
      abortSignal: ctl.signal,
      ...(this.now ? { now: this.now } : {}),
    });

    this.inflight = (async () => {
      try {
        return await this.harness.run(runtime);
      } finally {
        this.currentAbortCtl = null;
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  async cancel(): Promise<void> {
    this.currentAbortCtl?.abort();
    if (this.inflight) {
      await this.inflight.catch(() => undefined);
    }
  }

  updates(opts: { capacity?: number } = {}): AsyncIterableIterator<SessionUpdate> {
    return this.updateSink.subscribe(opts);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.cancel();
    this.updateSink.close();
    if (this.session.close) await this.session.close();
  }
}
