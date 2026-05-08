/**
 * RunningAgentImpl — the SDK handle returned to clients.
 *
 * Lifecycle:
 *   - prompt(text) appends a user_message_chunk + runs ONE turn to completion.
 *   - cancel() aborts the in-flight turn (the harness should observe the
 *     AbortSignal and stop promptly).
 *   - updates() returns an async iterable that yields every SessionUpdate
 *     emitted during turns (and any that the runtime emits out-of-band).
 *   - close() releases resources (sessions, providers, sink subscribers).
 */

import type { SessionUpdate } from "../types/acp.js";
import type {
  Harness,
  Provider,
  RunParameters,
  Runtime,
  Session,
  SessionContext,
  TurnResult,
} from "../types/interfaces.js";
import type { PermissionHandler } from "../types/permissions.js";
import type { AgentManifest, Capabilities } from "../types/manifest.js";

import { RuntimeImpl } from "../runtime/runtime.js";
import type { AgentState } from "../runtime/agent-state.js";
import type { UpdateSink } from "../runtime/update-sink.js";
import type { RuntimeServicesImpl } from "./run-agent.js";

export interface RunningAgent {
  /**
   * Append a user message and run one turn to completion. Returns the
   * turn's stop reason plus (when the harness reports it) the
   * cumulative usage breakdown matching ACP RFD `PromptResponse.usage`.
   *
   * `params` is forwarded to the harness for this single turn (effort,
   * streaming, lab-specific thinking config). The harness's defaults
   * apply for any unset fields.
   */
  prompt(text: string, params?: RunParameters): Promise<TurnResult>;
  cancel(): Promise<void>;
  updates(opts?: { capacity?: number }): AsyncIterableIterator<SessionUpdate>;
  readonly session: Session;
  /** Source manifest the agent was constructed from (diagnostics only). */
  readonly manifest: AgentManifest;
  /** Resolved [agent].system_prompt content. */
  readonly systemPrompt: string;
  /** Effective per-tool capability ceiling. */
  readonly capabilities: Capabilities;
  /** Resolved secret names (for diagnostics; never the values). */
  readonly secretNames: string[];
  /** Live skills/tools/ceiling view. */
  readonly agentState: AgentState;
  /**
   * Attach (or replace) the user-consent handler. Tools' next call to
   * `ctx.requestPermission()` observes the new handler. Pass null to
   * clear.
   */
  setPermissionHandler(handler: PermissionHandler | null): void;
  close(): Promise<void>;
}

interface RunningAgentImplOptions {
  manifest: AgentManifest;
  systemPrompt: string;
  capabilities: Capabilities;
  secrets: Record<string, string>;
  session: Session;
  harness: Harness;
  state: AgentState;
  updateSink: UpdateSink;
  providers: Provider[];
  /**
   * Shared mutable holder for the active permission handler. Both the
   * RunningAgent and the runtime services read through the same
   * reference so `setPermissionHandler()` after boot is visible to
   * tools mid-turn.
   */
  permissionHolder: { current: PermissionHandler | null };
  /** Runtime services impl — receives setAbortSignal each turn. */
  runtimeServices: RuntimeServicesImpl;
  now?: () => Date;
}

export class RunningAgentImpl implements RunningAgent {
  public readonly manifest: AgentManifest;
  public readonly systemPrompt: string;
  public readonly capabilities: Capabilities;
  public readonly session: Session;
  public readonly secretNames: string[];

  private readonly harness: Harness;
  private readonly state: AgentState;
  private readonly updateSink: UpdateSink;
  private readonly providers: Provider[];
  private readonly permissionHolder: { current: PermissionHandler | null };
  private readonly runtimeServices: RuntimeServicesImpl;
  private readonly now: (() => Date) | undefined;

  private currentAbortCtl: AbortController | null = null;
  private inflight: Promise<TurnResult> | null = null;
  private closed = false;

  constructor(opts: RunningAgentImplOptions) {
    this.manifest = opts.manifest;
    this.systemPrompt = opts.systemPrompt;
    this.capabilities = opts.capabilities;
    this.session = opts.session;
    this.harness = opts.harness;
    this.state = opts.state;
    this.updateSink = opts.updateSink;
    this.providers = opts.providers;
    this.permissionHolder = opts.permissionHolder;
    this.runtimeServices = opts.runtimeServices;
    this.secretNames = Object.keys(opts.secrets);
    this.now = opts.now;
  }

  get agentState(): AgentState {
    return this.state;
  }

  setPermissionHandler(handler: PermissionHandler | null): void {
    this.permissionHolder.current = handler ?? null;
  }

  async prompt(text: string, params?: RunParameters): Promise<TurnResult> {
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
    // Tools running this turn read ctx.abortSignal through the shared
    // runtimeServices object, which we update here.
    this.runtimeServices.setAbortSignal(ctl.signal);

    // Build the per-turn SessionContext and run the session's hooks.
    // The session never holds onto the context — it gets a fresh one
    // each turn, passed to the methods that need it.
    const sessionCtx: SessionContext = {
      harness: this.harness,
      systemPromptCore: this.systemPrompt,
      agentName: this.manifest.name,
      ...(this.manifest.description
        ? { agentDescription: this.manifest.description }
        : {}),
    };
    if (this.session.prepareTurn) {
      try {
        await Promise.resolve(this.session.prepareTurn(sessionCtx));
      } catch (e) {
        // A failing prepareTurn shouldn't kill the turn; surface it as
        // an agent_thought_chunk for visibility and continue.
        const msg = (e as Error).message ?? String(e);
        await this.session.append({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: `[session.prepareTurn error] ${msg}` },
        });
      }
    }
    let sessionSection = "";
    if (this.session.systemPromptSection) {
      try {
        sessionSection = await Promise.resolve(
          this.session.systemPromptSection(sessionCtx),
        );
      } catch {
        // A failing section shouldn't kill the turn; we just skip it.
        sessionSection = "";
      }
    }

    const runtime: Runtime = new RuntimeImpl({
      session: this.session,
      state: this.state,
      systemPromptCore: this.systemPrompt,
      updateSink: this.updateSink,
      agentName: this.manifest.name,
      ...(this.manifest.description
        ? { agentDescription: this.manifest.description }
        : {}),
      ...(sessionSection ? { sessionSection } : {}),
      abortSignal: ctl.signal,
      ...(this.now ? { now: this.now } : {}),
    });

    this.inflight = (async () => {
      try {
        return await this.harness.run(runtime, params);
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
  }
}
