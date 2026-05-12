/**
 * ACP server — built on `@agentclientprotocol/sdk`'s
 * `AgentSideConnection`. Loom plugs in an `Agent` implementation that
 * lazily boots a `RunningAgent` on the first `session/new`, then
 * fans `session/update` notifications back out for every emitted
 * `SessionUpdate`.
 *
 * Wire compliance is total: the SDK owns JSON-RPC dispatch, ndjson
 * framing, and the schema types. Loom only supplies the
 * agent-behavior implementation.
 */
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

/** Strip `readonly` modifiers off every property of `T`. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Protocol version Loom speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * The factory shape `AgentSideConnection` constructor expects: given
 * the live connection, return an `Agent` implementation.
 *
 * We wire one `LoomAcpAgent` per connection. The agent lazily boots
 * the underlying `RunningAgent` (so client `initialize` capabilities
 * are visible to factories before they instantiate).
 */
/**
 * Resolve (or boot) a `RunningAgent` for a given workspace cwd.
 *
 * Stdio mode boots lazily and re-boots on cwd change so that
 * `[capabilities].paths = ["./"]` resolves against the client's
 * workspace, not loom's launch directory. Tests typically supply a
 * pre-booted agent and ignore `cwd`.
 */
type AgentFactory = (cwd: string) => Promise<RunningAgent>;

interface SessionEntry {
  agent: RunningAgent;
  updateForwarder: Promise<void>;
  forwarderDone: AbortController;
  /**
   * The current model override, if the client set one via
   * `session/set_config_option`. Passed as `RunParameters.model`
   * on every subsequent `prompt()` so the harness routes to that
   * model instead of its default. `null` = use the harness's
   * configured default.
   */
  selectedModel: string | null;
  /**
   * Cached `configOptions` payload (the full list, with current
   * values reflected). Recomputed lazily on first request and on
   * every `setSessionConfigOption`.
   */
  configOptions: SessionConfigOption[];
}

/**
 * Source of the capability set Loom should advertise in
 * `initialize`. In stdio mode this is a manifest probe (doesn't boot
 * the agent); in tests it's typically derived from the pre-booted
 * agent the test set up.
 */
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
    // Bracket: if the client speaks a different major protocol
    // version, refuse loudly rather than degrade silently.
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

    // Capabilities come from a lightweight manifest probe — no
    // agent boot here. The full boot is deferred to `session/new`
    // where we have the client's workspace `cwd` and can resolve
    // path grants against the right root.
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
    // Loom doesn't require auth on stdio; treat as a no-op success.
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    validateCwd(params.cwd);
    rejectMcpServers(params.mcpServers);
    const agent = await this.factory(params.cwd);
    const sessionId = this.allocateSessionId();
    this.bindSession(sessionId, agent);
    // `bindSession` just inserted this entry under `sessionId`, so the
    // lookup is guaranteed to hit. Guard so a future refactor can't
    // silently produce `undefined`.
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
    // The session is now bound to p.sessionId. Register the routing
    // entry under the same id so subsequent prompts work.
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
    // If the client picked a model via `session/set_config_option`,
    // pass it through as a per-turn override. The harness sees it via
    // `RunParameters.model` and routes the API call accordingly.
    const runParams = entry.selectedModel
      ? { model: entry.selectedModel }
      : undefined;
    const result = await entry.agent.prompt(
      params.prompt as ContentBlock[],
      runParams,
    );
    // Loom uses "error" as an internal-only stop reason; map it to a
    // JSON-RPC error response rather than emit an out-of-spec value.
    // The harness puts the cause on `result.error.message`; the session
    // log is intentionally clean (no error chunk persisted).
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

  /**
   * Handle `session/set_config_option`. Today we recognize one
   * option id: `"model"` (drives `entry.selectedModel`). Unknown
   * option ids are rejected with `invalidParams` per spec. The
   * response carries the full updated `configOptions` array —
   * changing one option may affect the available values of others,
   * even though we currently only have the one.
   */
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

  /**
   * Compute the `configOptions` array for a session. Right now we
   * expose exactly one option — the harness's model selector —
   * when the harness has populated `models()` AND returned a
   * non-empty list. Skipped silently when the harness can't surface
   * a list (test harnesses, harnesses behind misconfigured creds,
   * etc.) so the agent still boots.
   */
  private async buildConfigOptions(
    entry: SessionEntry,
  ): Promise<SessionConfigOption[]> {
    const harness = entry.agent.harness;
    if (!harness.models || !harness.currentModel) return [];
    let models: HarnessModel[] = [];
    try {
      models = await Promise.resolve(harness.models());
    } catch {
      // Defensive: harness errors during model listing shouldn't
      // tear down session/new. Surface nothing instead.
      return [];
    }
    if (models.length === 0) return [];
    const current = entry.selectedModel ?? harness.currentModel();
    const options = models.map((m) => ({
      value: m.id,
      name: m.name ?? m.id,
      ...(m.description ? { description: m.description } : {}),
    }));
    // The harness's default model id is often an alias (e.g.
    // `claude-sonnet-4-5-latest`) that the underlying API resolves to
    // a dated canonical id (`claude-sonnet-4-5-20250929`). The
    // `models.list()` endpoint returns the canonical id only, so the
    // alias isn't in `options`. If we leave it that way, ACP clients
    // render the dropdown as "Unknown" because the `currentValue`
    // doesn't match any option. Prepend a synthetic option for the
    // current value so the dropdown always reflects what's actually
    // in use.
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

  /** Allocate a fresh routing sessionId. */
  private allocateSessionId(): SessionId {
    return `s${this.nextSessionIdCounter++}`;
  }

  /**
   * Bind a RunningAgent under a sessionId. Wires the agent's
   * permission handler through this connection's
   * `requestPermission()` and starts the update forwarder.
   */
  private bindSession(sessionId: SessionId, agent: RunningAgent): void {
    if (this.sessions.has(sessionId)) {
      // Idempotent rebind (e.g. for `loadSession`).
      return;
    }
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

  /**
   * Build a `PermissionHandler` that forwards each request over the
   * ACP connection. The handler injects `sessionId` (the runtime
   * doesn't know it) and forwards the SDK-shaped request verbatim.
   */
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
        // Client failure → treat as cancelled. Surface the original
        // error to logs but don't propagate (tools handle cancelled
        // explicitly).
        void e;
        return { outcome: { outcome: "cancelled" } };
      }
    };
  }

  /**
   * Build a `ClientBridge` over the ACP connection for one session.
   * Each method is only attached when the client advertised the
   * matching capability — tools structurally pattern-match on method
   * presence (`if (ctx.client?.readTextFile)`) rather than checking
   * a capability flag.
   *
   * `sessionId` is captured here and injected into every outbound
   * request so tools never have to thread it.
   */
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

  /**
   * Drain a `RunningAgent.updates()` async iterator into
   * `connection.sessionUpdate(...)` notifications. We filter Loom's
   * internal `"stop"` extension out — the wire signals turn end via
   * `PromptResponse.stopReason`.
   */
  private startUpdateForwarder(
    sessionId: SessionId,
    agent: RunningAgent,
    signal: AbortSignal,
  ): Promise<void> {
    return (async () => {
      const sub = agent.updates();
      for await (const u of sub) {
        if (signal.aborted) break;
        if (u.sessionUpdate === "stop") continue;
        try {
          await this.connection.sessionUpdate({
            sessionId,
            update: u as ACPSessionUpdate,
          });
        } catch {
          // Connection probably closed; bail out cleanly.
          break;
        }
      }
    })().catch(() => undefined);
  }

  /** Release a single session's resources. */
  private async closeSession_(sessionId: SessionId): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    entry.forwarderDone.abort();
    await entry.agent.close().catch(() => undefined);
    await entry.updateForwarder.catch(() => undefined);
  }

  /** Drain all sessions; called from `serveOverStdio` on disconnect. */
  async closeAll(): Promise<void> {
    for (const sid of [...this.sessions.keys()]) {
      await this.closeSession_(sid);
    }
  }

  /** Whether `initialize` has been processed (diagnostic only). */
  get hasInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * Validate the `cwd` field on `session/new` and `session/load`. The
 * spec requires an absolute path; we additionally require it to
 * exist and be a directory, since otherwise downstream tool calls
 * would all fail with cryptic ENOENTs.
 */
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

/**
 * Reject non-empty `mcpServers` payloads. Loom doesn't speak MCP yet;
 * silently dropping the array would let the client think its servers
 * are reachable, which is worse than a clean error.
 */
function rejectMcpServers(servers: McpServer[] | undefined): void {
  if (servers && servers.length > 0) {
    throw RequestError.invalidParams(
      { count: servers.length },
      "Loom does not currently support MCP servers; pass an empty `mcpServers: []`.",
    );
  }
}

/**
 * Run an ACP server over stdio for a single agent.
 *
 * Boots the agent lazily on the first `initialize` / `session/new`
 * call. If the client's `session/new` carries a `cwd` that differs
 * from the cwd we booted in, we `chdir` and re-boot —
 * `[capabilities].paths = ["./"]` is resolved at boot time, so the
 * grants must match the workspace root the client is referring to.
 */
export async function serveOverStdio(
  manifestPath: string,
  runAgentOptions?: Omit<RunAgentOptions, "clientAcpCapabilities" | "parent">,
): Promise<void> {
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );

  // Cached booted agent + the cwd we booted in. A `session/new` with
  // a different cwd evicts and re-boots.
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
    // Evict any prior agent before chdir-ing; closing flushes the
    // session and releases providers, so the next boot starts clean.
    if (cell.agent) {
      try {
        await cell.agent.close();
      } catch {
        /* non-fatal */
      }
      cell.agent = null;
    }
    // chdir before runAgent so manifest-relative paths AND default
    // grants (`paths: ["./"]` → path.resolve(".")) resolve against
    // the workspace the client supplied.
    process.chdir(target);
    cell.cwd = target;
    const { runAgent } = await import("../sdk/run-agent.js");
    cell.agent = await runAgent(manifestPath, {
      ...(runAgentOptions ?? {}),
      clientAcpCapabilities: negotiatedCaps,
    });
    return cell.agent;
  }

  // Capability probe — lightweight: parses the manifest, looks up
  // factories, returns their `acpCapabilities?(config)`. No agent
  // boot, no chdir, no cwd dependency.
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

/**
 * Construct an `AgentSideConnection` over the provided WHATWG stream
 * pair. Used by tests and library consumers that want to control the
 * transport directly (e.g. in-process pipes). Returns the connection;
 * call `await conn.closed` to wait for the peer to disconnect.
 */
export function serveOverStream(
  agentFactory: AgentFactory,
  stream: Stream,
  options: {
    onInitialize?(caps: ClientAcpCapabilities): void;
    /**
     * Optional probe override. Defaults to a probe that invokes the
     * factory with `process.cwd()`, derives the agent's manifest, and
     * runs `probeAcpCapabilitiesFromManifest`. Tests that want a fast
     * deterministic probe can supply their own.
     */
    probeCapabilities?: CapabilityProbe;
  } = {},
): { connection: AgentSideConnection; closeAll(): Promise<void> } {
  // Default probe: call the factory (pre-booted in test setups) and
  // run the manifest probe against its manifest. This is cheap when
  // the factory caches.
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
