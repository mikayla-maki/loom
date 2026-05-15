/**
 * RunningAgentImpl — the SDK handle returned to clients.
 *
 * `prompt()` appends a user_message_chunk and runs one turn to
 * completion; `cancel()` aborts the in-flight turn via AbortSignal;
 * `updates()` yields every SessionUpdate emitted; `close()` releases
 * sessions, providers, and sink subscribers.
 */

import type { ContentBlock, SessionUpdate } from "../types/acp.js";
import type {
  Agent,
  AgentPreamble,
  Harness,
  RunParameters,
  Runtime,
  Session,
  Tools,
  TurnResult,
} from "../types/interfaces.js";
import type { PermissionHandler } from "../types/permissions.js";
import type { ClientBridge } from "../runtime/client-bridge.js";
import type { AgentManifest, Capabilities } from "../types/manifest.js";
import type { Ref } from "../internal/util.js";

import { RuntimeImpl } from "../runtime/runtime.js";
import type { AgentState } from "../runtime/agent-state.js";
import type { UpdateSink } from "../runtime/update-sink.js";
import { agentForSession, type RuntimeServicesImpl } from "./run-agent.js";

export interface RunningAgent {
  /**
   * Append a user message and run one turn. Accepts either a plain
   * string (shorthand for `[{ type: "text", text }]`) or an array of
   * `ContentBlock`s for multi-part prompts (text + images + embedded
   * resources). Returns the stop reason and (when the harness reports
   * it) cumulative usage. `params` is forwarded to the harness for
   * this turn only; unset fields fall back to harness defaults.
   */
  prompt(
    prompt: string | ContentBlock[],
    params?: RunParameters,
  ): Promise<TurnResult>;
  cancel(): Promise<void>;
  updates(opts?: { capacity?: number }): AsyncIterableIterator<SessionUpdate>;
  readonly session: Session;
  /**
   * The harness driving this agent. Exposed (read-only) so SDK
   * consumers can call `harness.models()`, `harness.currentModel()`,
   * etc. — typically for surfacing a model picker in the host UI.
   */
  readonly harness: Harness;
  /** Source manifest (diagnostics only). */
  readonly manifest: AgentManifest;
  /** Resolved `[agent].system_prompt` content. */
  readonly systemPrompt: string;
  /** Effective per-tool capability ceiling. */
  readonly capabilities: Capabilities;
  /** Resolved secret names (never values). */
  readonly secretNames: string[];
  /** Live skills/tools/ceiling view. */
  readonly agentState: AgentState;
  /** Attach/replace the user-consent handler. Pass `null` to clear. */
  setPermissionHandler(handler: PermissionHandler | null): void;
  /**
   * Attach/replace the ACP client bridge. Pass `null` to clear.
   * Visible to every subsequent tool call via `ToolContext.client`.
   * The ACP server calls this from `bindSession`; CLI / SDK-direct
   * consumers leave it null (and tools fall back to local paths).
   */
  setClientBridge(bridge: ClientBridge | null): void;
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
  providers: Tools[];
  /**
   * Shared mutable holder for the active permission handler. The
   * RunningAgent and runtime services share this reference so
   * `setPermissionHandler()` is visible to tools mid-turn.
   */
  permissionHolder: Ref<PermissionHandler | null>;
  /**
   * Shared mutable holder for the active ACP client bridge. The
   * RunningAgent and runtime services share this reference so
   * `setClientBridge()` is visible to tools mid-turn.
   */
  clientBridgeHolder: Ref<ClientBridge | null>;
  /** Receives `setAbortSignal` each turn. */
  runtimeServices: RuntimeServicesImpl;
}

export class RunningAgentImpl implements RunningAgent {
  public readonly manifest: AgentManifest;
  public readonly systemPrompt: string;
  public readonly capabilities: Capabilities;
  public readonly session: Session;
  public readonly harness: Harness;
  public readonly secretNames: string[];
  private readonly state: AgentState;
  private readonly updateSink: UpdateSink;
  private readonly providers: Tools[];
  private readonly permissionHolder: Ref<PermissionHandler | null>;
  private readonly clientBridgeHolder: Ref<ClientBridge | null>;
  private readonly runtimeServices: RuntimeServicesImpl;

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
    this.clientBridgeHolder = opts.clientBridgeHolder;
    this.runtimeServices = opts.runtimeServices;
    this.secretNames = Object.keys(opts.secrets);
  }

  get agentState(): AgentState {
    return this.state;
  }

  setPermissionHandler(handler: PermissionHandler | null): void {
    this.permissionHolder.current = handler ?? null;
  }

  setClientBridge(bridge: ClientBridge | null): void {
    this.clientBridgeHolder.current = bridge ?? null;
  }

  async prompt(
    prompt: string | ContentBlock[],
    params?: RunParameters,
  ): Promise<TurnResult> {
    if (this.closed) throw new Error("Agent has been closed");
    if (this.inflight) {
      // Cancel-and-restart. A new prompt arriving mid-turn (user
      // sends another message while the agent is still responding)
      // supersedes the in-flight turn rather than queueing behind
      // it — that matches Zed-style "interrupt by typing" UX, and
      // is also what happens implicitly if the client sends
      // `session/cancel` + `session/prompt` in sequence (we just
      // don't depend on it).
      //
      // The aborted turn resolves with `stopReason: "cancelled"`;
      // any pending ACP `prompt` JSON-RPC response carries that
      // value back to the client. Then we proceed with the new
      // turn here.
      this.currentAbortCtl?.abort();
      await this.inflight.catch(() => undefined);
    }
    const blocks: ContentBlock[] =
      typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;
    // Each block lands as its own `user_message_chunk` so downstream
    // sessions can decide how to coalesce / persist them.
    for (const block of blocks) {
      const userUpdate: SessionUpdate = {
        sessionUpdate: "user_message_chunk",
        content: block,
      };
      await Promise.resolve(this.session.push?.(userUpdate) ?? [userUpdate]);
      this.updateSink.emit(userUpdate);
    }

    const ctl = new AbortController();
    this.currentAbortCtl = ctl;
    // Tools read ctx.abortSignal through the shared runtimeServices.
    this.runtimeServices.setAbortSignal(ctl.signal);

    // Per-turn Agent ref; session gets a fresh one each turn.
    // `agentForSession` scopes `spawnSubagent` to the session's deps.
    const baseAgent: Agent = {
      manifest: this.manifest,
      harness: this.harness,
      session: this.session,
      systemPromptCore: this.systemPrompt,
    };
    const agentRef = agentForSession(baseAgent, this.session);
    if (this.session.prepareTurn) {
      try {
        await Promise.resolve(this.session.prepareTurn(agentRef));
      } catch (e) {
        // Don't kill the turn; surface as agent_thought_chunk.
        const msg = (e as Error).message ?? String(e);
        await Promise.resolve(
          this.session.push?.({
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: `[session.prepareTurn error] ${msg}`,
            },
          }) ?? [],
        );
      }
    }
    let sessionSection = "";
    if (this.session.systemPromptSection) {
      try {
        sessionSection = await Promise.resolve(
          this.session.systemPromptSection(agentRef),
        );
      } catch {
        // Skip a failing section; don't kill the turn.
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
    });

    this.inflight = (async () => {
      try {
        // Snapshot the preamble — system prompt, history events, tool
        // list — if the caller wants it. Done here (not in the harness)
        // so it doesn't depend on harness behavior; every harness that
        // calls `runtime.systemPrompt()` / `runtime.getEvents()` /
        // `runtime.listTools()` will see exactly these values. Errors
        // propagate so callers can fail-fast on broken audit hooks.
        if (params?.onPreamble) {
          const preamble: AgentPreamble = {
            systemPrompt: runtime.systemPrompt(),
            events: await runtime.getEvents(),
            tools: runtime.listTools(),
          };
          await Promise.resolve(params.onPreamble(preamble));
        }
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
        await p.close?.();
      } catch {
        /* ignore cleanup errors */
      }
    }
  }
}
