import type { SessionUpdate, StopReason, TurnUsage } from "./acp.js";
import type { JSONSchema } from "./schema.js";
import type {
  AgentManifest,
  Capabilities,
  CapabilitySet,
  ToolGroup,
  ToolGroupVerdict,
} from "./manifest.js";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "./permissions.js";
import type { ClientAcpCapabilities } from "../runtime/acp-capabilities.js";
import type { RunningAgent } from "../sdk/running-agent.js";

export interface Session {
  /** Return events to forward downstream: `[event]` forward, `[]` drop, `[...]` transform. */
  push?(event: SessionUpdate): Promise<SessionUpdate[]>;

  /** `below` is what an upstream stage produced (empty for the outer call). */
  pull?(below: SessionUpdate[]): Promise<SessionUpdate[]>;

  prepareTurn?(agent: Agent): Promise<void> | void;

  systemPromptSection?(agent: Agent): string | Promise<string>;

  /**
   * Labeled `[tools]` tables this session contributes; collected once at
   * boot and judged against the agent's capability ceiling. Self-implemented
   * entries use `provider = "session"` and resolve through {@link resolveTool}.
   */
  tools?(): Promise<ToolGroup[]> | ToolGroup[];

  /**
   * Resolves `provider = "session"` tool names. Resolution order: this
   * method, then native built-ins, then SDK-supplied Tools. `null` falls
   * through.
   */
  resolveTool?(
    name: string,
    config: ToolConfig,
    agent: Agent,
    capabilities: CapabilitySet | undefined,
  ): Promise<Tool | null> | Tool | null;

  dependencies?: { subagents?: AgentManifest[] };

  list?(): Promise<SessionDescriptor[]>;

  /** Must mutate `this` in place and return it; the runtime does not rebind. */
  resume?(id: string): Promise<Session>;

  close?(): Promise<void>;
}

export interface Harness {
  /** Should honour `runtime.abortSignal`. */
  run(runtime: Runtime, params?: RunParameters): Promise<TurnResult>;

  /** One-shot, tool-free summarisation; does not write to any session. */
  summarise?(args: SummariseArgs): Promise<string>;

  /** Sibling harness with the same credentials/transport but a different model id. */
  withModel?(modelId: string): Harness;

  /** Recommended smaller/cheaper sibling of the configured model. */
  smallModel?(): string;

  currentModel?(): string;

  models?(): Promise<HarnessModel[]> | HarnessModel[];

  /**
   * Provider-native server-side tools the harness dispatches internally.
   * Unlike `Session.tools`, these are NOT auto-added; the manifest must opt
   * in via `[tools]` with `provider = "<harness-factory-name>"`.
   */
  availableTools?(): Promise<ToolRef[]> | ToolRef[];

  /**
   * Resolves harness-exposed names. Returns a stub `Tool` whose `execute()`
   * is generally never called — the harness intercepts dispatch in `run()`,
   * but the stub's descriptor still feeds system prompts and `loom audit`.
   */
  resolveTool?(
    name: string,
    config: ToolConfig,
    agent: Agent,
    capabilities: CapabilitySet | undefined,
  ): Promise<Tool | null> | Tool | null;
}

export interface HarnessModel {
  id: string;
  /** Defaults to `id` if omitted. */
  name?: string;
  description?: string;
}

export interface Tool extends ToolDescriptor {
  /** Capability kinds that MUST be granted; boot fails if any is missing. */
  requires?: string[];

  /** Capability kinds this tool MAY use if granted; boot doesn't fail when absent. */
  optional?: string[];

  /** The granted set; `"*"` = unrestricted, `{}` = none. Tools self-police on it. */
  capabilities?: CapabilitySet;

  /**
   * Tool-defined containment: is `subset` authorized by `superset`?
   * Strict semantics: a kind absent from `superset` is NOT granted.
   * Falls back to `defaultContains` when absent. Must be pure.
   */
  containsGrant?(
    superset: CapabilitySet | undefined,
    subset: CapabilitySet,
  ): boolean;

  /**
   * Tool-defined join of two grants. The result must contain both inputs
   * under `containsGrant` (the runtime asserts this law). Falls back to
   * `defaultMerge` when absent. Must be pure.
   */
  mergeGrants?(a: CapabilitySet, b: CapabilitySet): CapabilitySet;

  /**
   * Optional: produce a random VALID grant for this tool, given a
   * `random()` that returns a float in [0, 1). Used ONLY by the capability
   * algebra conformance checker (`checkGrantAlgebra`) in audit/tests — never
   * on a hot path. It lets the law checks run over the tool's real value
   * domain (e.g. bash's `commands`/`network` shapes) instead of generic
   * structural grants. Correctness here only affects test coverage, not
   * runtime security, so it's safe to trust. Omit to use the generic
   * generator.
   */
  sampleGrant?(random: () => number): CapabilitySet;

  secrets?: SecretNeeds;

  /** Read-only environment audit for `loom audit`. Must be side-effect-free. */
  audit?(): Promise<AuditFinding[]> | AuditFinding[];

  dependencies?: { subagents?: AgentManifest[] };

  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface SessionDescriptor {
  id: string;
  createdAt: string;
  updatedAt: string;
  agentName?: string;
}

export interface ToolRef {
  name: string;
  config: ToolConfig;
}

export interface Agent {
  /** Treated as immutable by the runtime; clone before deriving. */
  manifest: AgentManifest;
  harness: Harness;
  /** Possibly the outer `ChainedSession` wrapping a layered config. */
  session: Session;
  /** Resolved `[agent].system_prompt` text; empty when omitted. */
  systemPromptCore: string;
  /**
   * The effective capability ceiling — `[capabilities]` unioned with the
   * manifest's inline tool declarations — set by the runtime at boot.
   * Sessions may use it with `containsDeclaration` to trim contributions.
   */
  capabilities?: Capabilities;
  /**
   * Boot-time verdicts for contributed tool groups, set by the runtime.
   * Producers can match their own labels to learn whether they were accepted.
   */
  toolVerdicts?: ToolGroupVerdict[];
  /**
   * String form looks up by name in the caller's `dependencies.subagents`;
   * manifest form runs the supplied manifest inline. Either auto-fills
   * `parent` with this Agent. Undefined on hand-built refs.
   */
  spawnSubagent?(nameOrManifest: string | AgentManifest): Promise<RunningAgent>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export interface ToolCall {
  /** Unique per turn; ties calls to results. */
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  /** Stringified content the model will see. */
  content: string;
  isError?: boolean;
  /** Optional ACP-client rendering metadata; ignored by non-ACP consumers. */
  display?: ToolDisplay;
}

/** Optional ACP rendering metadata folded into the emitted `tool_call_update`. */
export interface ToolDisplay {
  /** Per-invocation title override, e.g. `"bash: \`ls -la\`"`. */
  title?: string;
  kind?: import("./acp.js").ToolKind;
  /** File locations this call touched; enables click-to-jump in IDE clients. */
  locations?: import("./acp.js").ToolCallLocation[];
  /** Rich content blocks; overrides the default text wrapping of `content`. */
  content?: import("./acp.js").ToolCallContent[];
  rawOutput?: unknown;
}

export type AuditSeverity = "ok" | "warning" | "error";

export interface AuditFinding {
  severity: AuditSeverity;
  message: string;
  remediation?: string;
}

export interface ToolContext {
  /** Secret slice filtered to this tool's allowlist. */
  secrets: Record<string, string>;
  abortSignal: AbortSignal;
  /** `sessionId` is filled in by the runtime. */
  requestPermission(
    req: Omit<RequestPermissionRequest, "sessionId">,
  ): Promise<RequestPermissionResponse>;
  agent: Agent;
  /**
   * Bridge to the ACP client; `undefined` in CLI / SDK-direct / test contexts.
   * Each method is present iff the client advertised the matching capability.
   */
  client?: import("../runtime/client-bridge.js").ClientBridge;
}

export interface Runtime {
  getEvents(): Promise<SessionUpdate[]>;

  update(update: SessionUpdate): Promise<void>;

  systemPrompt(): string;

  /** The `[agent].system_prompt` core only, for harnesses that roll their own assembly. */
  systemPromptCore(): string;

  listTools(): ToolDescriptor[];
  executeTool(call: ToolCall): Promise<ToolResult>;

  /**
   * Emits two `tool_call_update` events that differ only in `content`: the
   * session always gets `modelContent` as text (replayable); the client gets
   * `display.content` when set. `display.rawOutput` lands in both.
   */
  emitToolResult(args: {
    toolCallId: import("./acp.js").ToolCallId;
    status: import("./acp.js").ToolCallStatus;
    modelContent: string;
    display?: ToolDisplay;
  }): Promise<void>;

  readonly abortSignal: AbortSignal;
}

export interface TurnResult {
  stopReason: StopReason;
  usage?: TurnUsage;
  /**
   * Present only when `stopReason === "error"`. Must NOT also be emitted as an
   * `agent_message_chunk` — errors are protocol events, not assistant text.
   */
  error?: { message: string };
}

export interface RunParameters {
  stream?: boolean;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Raw lab-specific thinking config; wins over `effort` when set. */
  thinking?: unknown;
  maxOutputTokens?: number;
  model?: string;
  /**
   * Fires once per `prompt()`, after `prepareTurn`/`systemPromptSection` but
   * before dispatch; the runtime awaits it. Throwing aborts the turn.
   */
  onPreamble?: (preamble: AgentPreamble) => void | Promise<void>;
}

/** Read-only snapshot of what the harness is about to send for one turn. */
export interface AgentPreamble {
  systemPrompt: string;
  /** Pulled session events in order, including the triggering user message. */
  events: SessionUpdate[];
  tools: ToolDescriptor[];
}

/**
 * ACP capability contribution, deep-merged across harness + session + every
 * resolved tool when an ACP client sends `initialize`.
 */
export interface AcpCapabilityContribution {
  promptCapabilities?: Partial<
    import("@agentclientprotocol/sdk").PromptCapabilities
  >;
  sessionCapabilities?: Partial<
    import("@agentclientprotocol/sdk").SessionCapabilities
  >;
  loadSession?: boolean;
  experimental?: Record<string, unknown>;
}

export interface SummariseArgs {
  events: SessionUpdate[];
  instruction: string;
  /** Usually `agent.systemPromptCore`. */
  systemPrompt: string;
  abortSignal?: AbortSignal;
}

export interface SecretNeeds {
  /** Fail boot if missing. */
  required?: string[];
  /** Loaded best-effort. */
  optional?: string[];
}

export interface SessionFactory {
  readonly name: string;
  readonly secrets?: SecretNeeds;
  /** Needs a parent agent and cannot be used at the top level (e.g. `fork-of-parent`). */
  readonly requiresParent?: boolean;
  /**
   * A pass-through layer transforms events but does not persist them; the
   * runtime fails boot if a chain has no non-pass-through layer. Default
   * `false` = stores events.
   */
  readonly passThrough?: boolean;
  /** Called at `initialize` without instantiating a session. Must be pure. */
  acpCapabilities?(config: Record<string, unknown>): AcpCapabilityContribution;
  create(
    config: Record<string, unknown>,
    ctx: FactoryContext,
    secrets: Record<string, string>,
    parent?: Agent,
  ): Promise<Session> | Session;
}

export interface HarnessFactory {
  readonly name: string;
  readonly secrets?: SecretNeeds;
  /** See `SessionFactory.requiresParent`. */
  readonly requiresParent?: boolean;
  /** Called at `initialize` without instantiating a harness. Must be pure. */
  acpCapabilities?(config: Record<string, unknown>): AcpCapabilityContribution;
  create(
    config: Record<string, unknown>,
    ctx: FactoryContext,
    secrets: Record<string, string>,
    parent?: Agent,
  ): Promise<Harness> | Harness;
}

export interface FactoryContext {
  manifestDir: string;
  agentName: string;
  loomVersion: string;
  clientCapabilities: ClientAcpCapabilities;
  /** Whether this construction serves a live agent or `loom audit`. Defaults to `"run"`. */
  purpose?: "run" | "audit";
  /**
   * Per-agent directory Loom guarantees exists, one root per `[agent].storage_id`.
   * Namespace by factory name to avoid stomping siblings.
   */
  storage: string;
  /** The manifest's `[agent.metadata]` table verbatim; `{}` when absent. */
  metadata: Record<string, unknown>;
}

/** Per-tool config; the string shorthand is parsed into `provider` upstream. */
export type ToolConfig = Record<string, unknown>;

/** Usable only after every Tools `init()` has returned. */
export interface RuntimePrimitives {
  requestPermission(
    req: Omit<RequestPermissionRequest, "sessionId">,
  ): Promise<RequestPermissionResponse>;
}

export interface InitArgs {
  manifest: AgentManifest;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  factoryContext: FactoryContext;
  runtime: RuntimePrimitives;
}

export interface Tools {
  /** Runs in registration order; don't call `args.runtime` methods from here. */
  init?(args: InitArgs): Promise<void> | void;

  /**
   * Construct a Tool for this reference, or return `null` to decline.
   * `capabilities` is the `[capabilities.<name>]` grant forwarded to the tool.
   */
  resolveTool(
    name: string,
    config: ToolConfig,
    agent: Agent,
    capabilities: CapabilitySet | undefined,
  ): Promise<Tool | null> | Tool | null;

  close?(): Promise<void> | void;
}
