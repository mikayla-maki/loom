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
  prompt(
    prompt: string | ContentBlock[],
    params?: RunParameters,
  ): Promise<TurnResult>;
  cancel(): Promise<void>;
  updates(opts?: { capacity?: number }): AsyncIterableIterator<SessionUpdate>;
  readonly session: Session;
  readonly harness: Harness;
  readonly manifest: AgentManifest;
  readonly systemPrompt: string;
  readonly capabilities: Capabilities;
  readonly secretNames: string[];
  readonly agentState: AgentState;
  setPermissionHandler(handler: PermissionHandler | null): void;
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
  permissionHolder: Ref<PermissionHandler | null>;
  clientBridgeHolder: Ref<ClientBridge | null>;
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
      // A prompt arriving mid-turn cancels-and-restarts (interrupt-by-typing).
      this.currentAbortCtl?.abort();
      await this.inflight.catch(() => undefined);
    }
    const blocks: ContentBlock[] =
      typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;
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
    this.runtimeServices.setAbortSignal(ctl.signal);

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
        // ignore cleanup errors
      }
    }
  }
}
