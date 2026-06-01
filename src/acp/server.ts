import * as path from "node:path";
import * as fs from "node:fs";
import { Readable, Writable } from "node:stream";

import {
  AgentSideConnection,
  RequestError,
  ndJsonStream,
  type Agent as ACPAgent,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionId,
  type SessionUpdate as ACPSessionUpdate,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type StopReason,
  type Stream,
} from "@agentclientprotocol/sdk";

import type { RunningAgent } from "../sdk/running-agent.js";
import type { RunAgentOptions } from "../sdk/run-agent.js";
import { LOOM_VERSION } from "../sdk/run-agent.js";
import { DEFAULT_CLIENT_ACP_CAPABILITIES } from "../runtime/acp-capabilities.js";
import type { ClientAcpCapabilities } from "../runtime/acp-capabilities.js";
import type { ClientBridge } from "../runtime/client-bridge.js";
import type { HarnessModel } from "../types/interfaces.js";
import type { PermissionHandler } from "../types/permissions.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export const ACP_PROTOCOL_VERSION = 1;

type AgentFactory = (cwd: string) => Promise<RunningAgent>;

interface SessionEntry {
  agent: RunningAgent;
  updateForwarder: Promise<void>;
  forwarderDone: AbortController;
  selectedModel: string | null;
  configOptions: SessionConfigOption[];
}

type CapabilityProbe = (clientCaps: ClientAcpCapabilities) => Promise<{
  agentCapabilities: import("@agentclientprotocol/sdk").AgentCapabilities;
  agentInfo: { name: string; version: string; title?: string };
}>;

class LoomAcpAgent implements ACPAgent {
  private readonly sessions = new Map<string, SessionEntry>();
  private clientCapabilities: ClientAcpCapabilities =
    DEFAULT_CLIENT_ACP_CAPABILITIES;
  private initialized = false;
  private nextSessionIdCounter = 1;

  constructor(
    private readonly connection: AgentSideConnection,
    private readonly factory: AgentFactory,
    private readonly probeCapabilities: CapabilityProbe,
    private readonly onInitialize:
      | ((caps: ClientAcpCapabilities) => void)
      | undefined,
  ) {}

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    if (
      typeof params.protocolVersion === "number" &&
      params.protocolVersion !== ACP_PROTOCOL_VERSION
    ) {
      throw RequestError.invalidParams(
        {
          received: params.protocolVersion,
          supported: [ACP_PROTOCOL_VERSION],
        },
        `unsupported ACP protocolVersion ${params.protocolVersion} (this server speaks ${ACP_PROTOCOL_VERSION})`,
      );
    }
    if (params.clientCapabilities) {
      this.clientCapabilities = {
        ...DEFAULT_CLIENT_ACP_CAPABILITIES,
        ...params.clientCapabilities,
      };
    }
    this.initialized = true;
    try {
      this.onInitialize?.(this.clientCapabilities);
    } catch {
      // Hook errors are non-fatal; the agent will still boot.
    }

    let probe: Awaited<ReturnType<CapabilityProbe>>;
    try {
      probe = await this.probeCapabilities(this.clientCapabilities);
    } catch {
      probe = {
        agentCapabilities: {},
        agentInfo: { name: "loom", version: LOOM_VERSION },
      };
    }

    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: probe.agentCapabilities,
      agentInfo: probe.agentInfo,
    };
  }

  async authenticate(_p: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    validateCwd(params.cwd);
    rejectMcpServers(params.mcpServers);
    const agent = await this.factory(params.cwd);
    const sessionId = this.allocateSessionId();
    this.bindSession(sessionId, agent);
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(
        `acp: session ${sessionId} missing after bindSession (internal invariant violated)`,
      );
    }
    entry.configOptions = await this.buildConfigOptions(entry);
    const response: NewSessionResponse = { sessionId };
    if (entry.configOptions.length > 0) {
      response.configOptions = entry.configOptions;
    }
    return response;
  }

  async loadSession(p: LoadSessionRequest): Promise<LoadSessionResponse> {
    validateCwd(p.cwd);
    rejectMcpServers(p.mcpServers);
    const agent = await this.factory(p.cwd);
    const resume = agent.session.resume;
    if (typeof resume !== "function") {
      throw RequestError.methodNotFound("session/load");
    }
    try {
      await resume.call(agent.session, p.sessionId);
    } catch (e) {
      throw RequestError.internalError(undefined, (e as Error).message);
    }
    this.bindSession(p.sessionId, agent);
    return {};
  }

  async closeSession(p: CloseSessionRequest): Promise<CloseSessionResponse> {
    await this.closeSession_(p.sessionId);
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const entry = this.sessions.get(params.sessionId);
    if (!entry) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `unknown sessionId: ${params.sessionId}`,
      );
    }
    const runParams = entry.selectedModel
      ? { model: entry.selectedModel }
      : undefined;
    const result = await entry.agent.prompt(
      params.prompt as ContentBlock[],
      runParams,
    );
    // Loom uses "error" as an internal-only stop reason; map it to a
    // JSON-RPC error rather than emit an out-of-spec wire value.
    if (result.stopReason === "error") {
      throw RequestError.internalError(
        undefined,
        result.error?.message ?? "agent error",
      );
    }
    return {
      stopReason: result.stopReason as StopReason,
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const entry = this.sessions.get(params.sessionId);
    if (entry) await entry.agent.cancel();
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const entry = this.sessions.get(params.sessionId);
    if (!entry) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `unknown sessionId: ${params.sessionId}`,
      );
    }

    if (params.configId === "model") {
      const value = (params as { value?: unknown }).value;
      if (typeof value !== "string" || !value) {
        throw RequestError.invalidParams(
          { configId: params.configId, value },
          `setSessionConfigOption: 'model' requires a string value`,
        );
      }
      entry.selectedModel = value;
      entry.configOptions = await this.buildConfigOptions(entry);
      return { configOptions: entry.configOptions };
    }

    throw RequestError.invalidParams(
      { configId: params.configId },
      `setSessionConfigOption: unknown configId '${params.configId}'`,
    );
  }

  private async buildConfigOptions(
    entry: SessionEntry,
  ): Promise<SessionConfigOption[]> {
    const harness = entry.agent.harness;
    if (!harness.models || !harness.currentModel) return [];
    let models: HarnessModel[] = [];
    try {
      models = await Promise.resolve(harness.models());
    } catch {
      return [];
    }
    if (models.length === 0) return [];
    const current = entry.selectedModel ?? harness.currentModel();
    const options = models.map((m) => ({
      value: m.id,
      name: m.name ?? m.id,
      ...(m.description ? { description: m.description } : {}),
    }));
    // The current model id is often an alias that `models.list()` omits;
    // synthesize an option so the dropdown doesn't render "Unknown".
    if (!options.some((o) => o.value === current)) {
      options.unshift({ value: current, name: current });
    }
    return [
      {
        id: "model",
        name: "Model",
        type: "select",
        category: "model",
        currentValue: current,
        options,
      },
    ];
  }

  private allocateSessionId(): SessionId {
    return `s${this.nextSessionIdCounter++}`;
  }

  private bindSession(sessionId: SessionId, agent: RunningAgent): void {
    if (this.sessions.has(sessionId)) return;
    agent.setPermissionHandler(this.makeForwardingPermissionHandler(sessionId));
    agent.setClientBridge(this.makeClientBridge(sessionId));
    const ctl = new AbortController();
    const updateForwarder = this.startUpdateForwarder(
      sessionId,
      agent,
      ctl.signal,
    );
    this.sessions.set(sessionId, {
      agent,
      updateForwarder,
      forwarderDone: ctl,
      selectedModel: null,
      configOptions: [],
    });
  }

  private makeForwardingPermissionHandler(
    sessionId: SessionId,
  ): PermissionHandler {
    return async (
      req: Omit<RequestPermissionRequest, "sessionId">,
    ): Promise<RequestPermissionResponse> => {
      const full: RequestPermissionRequest = { ...req, sessionId };
      try {
        return await this.connection.requestPermission(full);
      } catch (e) {
        void e;
        return { outcome: { outcome: "cancelled" } };
      }
    };
  }

  private makeClientBridge(sessionId: SessionId): ClientBridge {
    const conn = this.connection;
    const caps = this.clientCapabilities;

    const bridge: ClientBridge = { capabilities: caps };

    if (caps.fs?.readTextFile) {
      (bridge as Mutable<ClientBridge>).readTextFile = async (params) => {
        const res = await conn.readTextFile({ ...params, sessionId });
        return res.content;
      };
    }
    if (caps.fs?.writeTextFile) {
      (bridge as Mutable<ClientBridge>).writeTextFile = async (params) => {
        await conn.writeTextFile({ ...params, sessionId });
      };
    }
    if (caps.terminal) {
      (bridge as Mutable<ClientBridge>).createTerminal = (params) =>
        conn.createTerminal({ ...params, sessionId });
    }
    return bridge;
  }

  private startUpdateForwarder(
    sessionId: SessionId,
    agent: RunningAgent,
    signal: AbortSignal,
  ): Promise<void> {
    return (async () => {
      const sub = agent.updates();
      for await (const u of sub) {
        if (signal.aborted) break;
        // "stop" is a Loom-internal extension; the wire signals turn end
        // via PromptResponse.stopReason, so never forward it.
        if (u.sessionUpdate === "stop") continue;
        try {
          await this.connection.sessionUpdate({
            sessionId,
            update: u as ACPSessionUpdate,
          });
        } catch {
          break;
        }
      }
    })().catch(() => undefined);
  }

  private async closeSession_(sessionId: SessionId): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    entry.forwarderDone.abort();
    await entry.agent.close().catch(() => undefined);
    await entry.updateForwarder.catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    for (const sid of [...this.sessions.keys()]) {
      await this.closeSession_(sid);
    }
  }

  get hasInitialized(): boolean {
    return this.initialized;
  }
}

function validateCwd(cwd: string): void {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw RequestError.invalidParams(
      { cwd },
      `cwd must be an absolute path (got ${JSON.stringify(cwd)})`,
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch (e) {
    throw RequestError.invalidParams(
      { cwd },
      `cwd does not exist or is not accessible: ${(e as Error).message}`,
    );
  }
  if (!stat.isDirectory()) {
    throw RequestError.invalidParams({ cwd }, `cwd is not a directory: ${cwd}`);
  }
}

function rejectMcpServers(servers: McpServer[] | undefined): void {
  if (servers && servers.length > 0) {
    throw RequestError.invalidParams(
      { count: servers.length },
      "Loom does not currently support MCP servers; pass an empty `mcpServers: []`.",
    );
  }
}

export async function serveOverStdio(
  manifestPath: string,
  runAgentOptions?: Omit<RunAgentOptions, "clientAcpCapabilities" | "parent">,
): Promise<void> {
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );

  const cell: { agent: RunningAgent | null; cwd: string | null } = {
    agent: null,
    cwd: null,
  };
  let negotiatedCaps: ClientAcpCapabilities = DEFAULT_CLIENT_ACP_CAPABILITIES;

  async function bootForCwd(cwd: string): Promise<RunningAgent> {
    const target = path.resolve(cwd);
    if (cell.agent && cell.cwd === target) {
      return cell.agent;
    }
    if (cell.agent) {
      try {
        await cell.agent.close();
      } catch {
        /* non-fatal */
      }
      cell.agent = null;
    }
    // chdir before runAgent so manifest-relative paths and default
    // grants (paths: ["./"]) resolve against the client's workspace.
    process.chdir(target);
    cell.cwd = target;
    const { runAgent } = await import("../sdk/run-agent.js");
    cell.agent = await runAgent(manifestPath, {
      ...(runAgentOptions ?? {}),
      clientAcpCapabilities: negotiatedCaps,
    });
    return cell.agent;
  }

  const probeCapabilities: CapabilityProbe = async (clientCaps) => {
    const { probeAcpCapabilities } = await import("../runtime/acp-probe.js");
    return probeAcpCapabilities(manifestPath, clientCaps);
  };

  let loomAgent: LoomAcpAgent | undefined;
  const connection = new AgentSideConnection((conn) => {
    loomAgent = new LoomAcpAgent(
      conn,
      bootForCwd,
      probeCapabilities,
      (caps) => {
        negotiatedCaps = { ...DEFAULT_CLIENT_ACP_CAPABILITIES, ...caps };
      },
    );
    return loomAgent;
  }, stream);

  await connection.closed;
  try {
    await loomAgent?.closeAll();
  } finally {
    if (cell.agent) {
      try {
        await cell.agent.close();
      } catch {
        /* shutdown errors are non-fatal */
      }
    }
  }
}

export function serveOverStream(
  agentFactory: AgentFactory,
  stream: Stream,
  options: {
    onInitialize?(caps: ClientAcpCapabilities): void;
    probeCapabilities?: CapabilityProbe;
  } = {},
): { connection: AgentSideConnection; closeAll(): Promise<void> } {
  const defaultProbe: CapabilityProbe = async (clientCaps) => {
    const { probeAcpCapabilitiesFromManifest } =
      await import("../runtime/acp-probe.js");
    const agent = await agentFactory(process.cwd());
    return probeAcpCapabilitiesFromManifest(
      agent.manifest,
      agent.manifest.manifestPath,
      clientCaps,
    );
  };

  let loomAgent: LoomAcpAgent | undefined;
  const connection = new AgentSideConnection((conn) => {
    loomAgent = new LoomAcpAgent(
      conn,
      agentFactory,
      options.probeCapabilities ?? defaultProbe,
      options.onInitialize,
    );
    return loomAgent;
  }, stream);
  return {
    connection,
    closeAll: () => loomAgent?.closeAll() ?? Promise.resolve(),
  };
}
