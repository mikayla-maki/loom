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
import type {
  Harness,
  Provider,
  Runtime,
  Session,
} from "../types/interfaces.js";
import type { PermissionHandler } from "../types/permissions.js";

import { RuntimeImpl } from "../runtime/runtime.js";
import type { AgentState } from "../runtime/agent-state.js";
import type { UpdateSink } from "../runtime/update-sink.js";
import type { ResolvedAgentManifest } from "../manifest/resolver.js";
import type { LoomServer } from "../server/server.js";

export interface RunningAgent {
  prompt(text: string): Promise<StopReason>;
  cancel(): Promise<void>;
  updates(opts?: { capacity?: number }): AsyncIterableIterator<SessionUpdate>;
  readonly session: Session;
  readonly resolved: ResolvedAgentManifest;
  /** Resolved secret values (for diagnostics; never logged). */
  readonly secretNames: string[];
  /** Mutable runtime state — live tool table, skills list, ceiling. */
  readonly agentState: AgentState;
  /**
   * Attach (or replace) the capability-expansion + tool-consent handler.
   * The next turn's runtime captures this value. Pass null to clear.
   */
  setPermissionHandler(handler: PermissionHandler | null): void;
  close(): Promise<void>;
}

interface RunningAgentImplOptions {
  resolved: ResolvedAgentManifest;
  secrets: Record<string, string>;
  session: Session;
  harness: Harness;
  state: AgentState;
  updateSink: UpdateSink;
  providers?: Provider[];
  /** Embed-mode broker server. Closed when the agent closes. */
  server?: LoomServer;
  /**
   * Shared mutable holder for the active permission handler. Both this
   * RunningAgentImpl and the privileged in-process tools read through the
   * same reference, so a setPermissionHandler() call after boot is visible
   * everywhere.
   */
  permissionHolder: { current: PermissionHandler | null };
  now?: () => Date;
}

export class RunningAgentImpl implements RunningAgent {
  public readonly session: Session;
  public readonly resolved: ResolvedAgentManifest;
  public readonly secretNames: string[];

  private readonly harness: Harness;
  private readonly state: AgentState;
  private readonly updateSink: UpdateSink;
  private readonly providers: Provider[];
  private readonly server: LoomServer | undefined;
  private readonly permissionHolder: { current: PermissionHandler | null };
  private readonly now: (() => Date) | undefined;

  private currentAbortCtl: AbortController | null = null;
  private inflight: Promise<StopReason> | null = null;
  private closed = false;

  constructor(opts: RunningAgentImplOptions) {
    this.resolved = opts.resolved;
    this.session = opts.session;
    this.harness = opts.harness;
    this.state = opts.state;
    this.updateSink = opts.updateSink;
    this.providers = opts.providers ?? [];
    this.server = opts.server;
    this.permissionHolder = opts.permissionHolder;
    this.secretNames = Object.keys(opts.secrets);
    this.now = opts.now;
  }

  /** Live access to the mutable AgentState (skills/ceiling/tool table). */
  get agentState(): AgentState {
    return this.state;
  }

  setPermissionHandler(handler: PermissionHandler | null): void {
    this.permissionHolder.current = handler ?? null;
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
      state: this.state,
      systemPromptCore: this.resolved.systemPrompt,
      updateSink: this.updateSink,
      agentName: this.resolved.source.name,
      ...(this.resolved.source.description
        ? { agentDescription: this.resolved.source.description }
        : {}),
      abortSignal: ctl.signal,
      ...(this.permissionHolder.current
        ? { permissionHandler: this.permissionHolder.current }
        : {}),
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

  updates(
    opts: { capacity?: number } = {},
  ): AsyncIterableIterator<SessionUpdate> {
    return this.updateSink.subscribe(opts);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.cancel();
    this.updateSink.close();
    if (this.session.close) await this.session.close();
    for (const p of this.providers) {
      try {
        await p.close();
      } catch {
        /* ignore cleanup errors */
      }
    }
    if (this.server) {
      await this.server.close().catch(() => undefined);
    }
  }
}
