/**
 * Core runtime interfaces.
 *
 * Loom turns an agent.toml into a running agent. The shape is:
 *   Harness  — compute (model API loop)
 *   Session  — memory (events in, events out)
 *   Tool     — JS objects the model calls, built by Providers
 *
 * Trust contract: tools and extensions are runtime-trust class — the
 * user installed them. Loom does not sandbox them; tools that need
 * isolation (e.g. bash) ship their own.
 */

import type { SessionUpdate, StopReason, TurnUsage } from "./acp.js";
import type { JSONSchema } from "./schema.js";
import type { AgentManifest, CapabilitySet } from "./manifest.js";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "./permissions.js";
import type { ClientAcpCapabilities } from "../runtime/acp-capabilities.js";
import type { RunningAgent } from "../sdk/running-agent.js";

/**
 * The agent's memory layer.
 */
export interface Session {
  /**
   * An event happened. Return the events to forward downstream:
   *   [event]  — forward (default)
   *   [...]    — transform or fan-out
   *   []       — drop
   */
  push?(event: SessionUpdate): Promise<SessionUpdate[]>;

  /**
   * Return the session's view of the context window. `below` is what
   * an upstream stage produced (empty for the outer call). Default:
   * return `below` unchanged.
   */
  pull?(below: SessionUpdate[]): Promise<SessionUpdate[]>;

  /** Per-turn hook. Runs after the user message, before runtime build. */
  prepareTurn?(agent: Agent): Promise<void> | void;

  /** Contribute a section to the assembled system prompt. */
  systemPromptSection?(agent: Agent): string | Promise<string>;

  /** Tools this session adds to the agent's tool table. */
  tools?(): Promise<ToolRef[]> | ToolRef[];

  /**
   * Optional inline tool resolver. A Session that contributes tool
   * names via {@link Session.tools} can ALSO own their
   * implementations by implementing this method — the runtime treats
   * the session as an implicit Tools provider for the names it lists.
   *
   * Resolution order at bind time for session-contributed names:
   *   1. `session.resolveTool(name, config, agent, capabilities)`.
   *   2. The native built-in Tools (the SkillsSession pattern —
   *      names like `bash` whose implementation lives in native).
   *   3. SDK-supplied Tools, if any.
   *
   * Returning `null` says "I don't own this one, fall through."
   *
   * Composition note: `ChainedSession` aggregates this across layers
   * — each child's `resolveTool` is tried in declaration order until
   * one returns non-null.
   */
  resolveTool?(
    name: string,
    config: ToolConfig,
    agent: Agent,
    capabilities: CapabilitySet | undefined,
  ): Promise<Tool | null> | Tool | null;

  /** Sub-agents this session may spawn. Self-declared for audit. */
  dependencies?: { subagents?: AgentManifest[] };

  /** Filesystem paths this session vouches for. See `TrustedPath`. */
  trustedPaths?(): Promise<TrustedPath[]> | TrustedPath[];

  /** List persisted sessions this provider manages. */
  list?(): Promise<SessionDescriptor[]>;

  /**
   * Resume a previously-persisted session by id. Contract: mutate
   * `this` in place to point at the requested state and return `this`.
   * The runtime does not rebind, so returning a different Session
   * leaves its state unused.
   */
  resume?(id: string): Promise<Session>;

  /** Release resources (file handles, etc.). */
  close?(): Promise<void>;
}

export interface Harness {
  /**
   * Run one turn. Pull events, call the model, dispatch tool calls,
   * return the result. Should honour `runtime.abortSignal`.
   */
  run(runtime: Runtime, params?: RunParameters): Promise<TurnResult>;

  /**
   * One-shot, tool-free summarisation. Returns the assistant text;
   * does not write to any session. Default helper drives `run()`
   * against a synthetic Runtime when omitted.
   */
  summarise?(args: SummariseArgs): Promise<string>;

  /**
   * Build a sibling harness with the same credentials/transport but
   * a different model id. Implementations should reuse the API key,
   * base URL, and other connection state — only the model id
   * changes. Used by parent-derived sub-agent harness factories
   * (e.g. `small-model-of-parent`) to route a sub-agent through a
   * cheaper or faster model without re-authenticating.
   *
   * Optional. Harnesses that have no concept of swappable models
   * (e.g. the scripted `test` harness) may omit it; consumers must
   * tolerate `undefined`.
   */
  withModel?(modelId: string): Harness;

  /**
   * The harness's recommendation for a smaller / cheaper / faster
   * sibling of the currently-configured model. Used as the default
   * by parent-derived factories (e.g. `small-model-of-parent`) when
   * the manifest doesn't pin a specific model.
   *
   * Implementations typically pattern-match the current model id
   * (`claude-sonnet-*` → `claude-haiku-*`, `gpt-4o` → `gpt-4o-mini`)
   * and fall back to a known fast default when the pattern doesn't
   * match.
   *
   * Optional. Harnesses that don't expose a small variant can omit
   * it; consumers tolerate `undefined` and require the manifest to
   * specify the model explicitly.
   */
  smallModel?(): string;
}

export interface Tool extends ToolDescriptor {
  /**
   * Capability kinds that MUST be granted for this tool to function.
   * Boot fails if any required kind is missing from the grant.
   *
   *   bash:      requires = ["subprocess"]
   *   read_file: requires = ["paths"]
   */
  requires?: string[];

  /**
   * Capability kinds this tool MAY use if granted. Inform `loom audit`
   * and sandbox profile derivation; boot doesn't fail when absent.
   *
   *   bash: optional = ["paths", "network", "env"]
   */
  optional?: string[];

  /**
   * The granted set this tool was constructed with. Tools self-police
   * by reading this at execute time. `"*"` = unrestricted; `{}` = none.
   */
  capabilities?: CapabilitySet;

  /** Secret names this tool wants. Resolved at boot. */
  secrets?: SecretNeeds;

  /**
   * Environment audit. Called by `loom audit` to surface runtime
   * preconditions ("sandbox-exec missing", "granted dir doesn't exist").
   * MUST be read-only and side-effect-free.
   */
  audit?(): Promise<AuditFinding[]> | AuditFinding[];

  /** Sub-agents this tool may spawn. Self-declared for audit. */
  dependencies?: { subagents?: AgentManifest[] };

  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

// ─── Session ─────────────────────────────────────────────────────────────

export interface SessionDescriptor {
  id: string;
  createdAt: string;
  updatedAt: string;
  agentName?: string;
}

/**
 * A filesystem path a session vouches for. Path-aware tools may union
 * these with their manifest grant; bash deliberately ignores them.
 * Self-declaration only — surfaced by `loom audit`, not enforced.
 */
export interface TrustedPath {
  /** Absolute path. */
  path: string;
  /** Access the producer asks for. Read-only tools accept any level. */
  access: "read" | "write" | "read-write";
  /** Optional human-readable rationale, shown in `loom audit`. */
  reason?: string;
}

/**
 * A reference to a tool the runtime should add to the agent's tool
 * table. The runtime routes `name` through a provider — either the
 * native built-ins, whichever Tools contribution claims it, or the
 * Session itself if it implements `resolveTool` (see
 * {@link Session.resolveTool}).
 */
export interface ToolRef {
  name: string;
  config: ToolConfig;
}

// ─── Agent ───────────────────────────────────────────────────────────────

/**
 * The runtime triple: harness + session + identity
 */
export interface Agent {
  harness: Harness;
  session: Session;
  /** Unassembled `[agent].system_prompt` content. */
  systemPromptCore: string;
  agentName: string;
  agentDescription?: string;
  /**
   * Spawn a sub-agent. String form looks up by name in the caller's
   * own `dependencies.subagents`; manifest form runs the supplied
   * manifest inline. Either path auto-fills `parent` with this Agent.
   * Throws `ResolutionError` if a named lookup misses.
   *
   * Undefined on hand-built refs (e.g. SDK consumers); always present
   * on runtime-supplied self-refs.
   */
  spawnSubagent?(nameOrManifest: string | AgentManifest): Promise<RunningAgent>;
}

// ─── Tool ────────────────────────────────────────────────────────────────

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
  /** True if the tool failed. */
  isError?: boolean;
}

/**
 *   ok      — surfaced for visibility (e.g. "sandbox-exec available")
 *   warning — degraded but functional (e.g. "running unsandboxed")
 *   error   — tool will fail or misbehave (e.g. "sandbox-exec missing")
 */
export type AuditSeverity = "ok" | "warning" | "error";

export interface AuditFinding {
  severity: AuditSeverity;
  message: string;
  /** Human-readable suggestion to fix the finding. */
  remediation?: string;
}

/** Per-call context, built by the runtime at every dispatch. */
export interface ToolContext {
  /** Secret slice filtered to this tool's allowlist. */
  secrets: Record<string, string>;
  /** Current turn's abort signal. */
  abortSignal: AbortSignal;
  /**
   * Ask the SDK consumer (or ACP client) for user consent.
   *
   * The tool supplies the `toolCall` metadata plus an `options[]`
   * array of `PermissionOption`s to choose from (see
   * `standardPermissionOptions()` for the common four-option set).
   * `sessionId` is filled in by the runtime.
   */
  requestPermission(
    req: Omit<RequestPermissionRequest, "sessionId">,
  ): Promise<RequestPermissionResponse>;
  /** The owning agent. `spawnSubagent` is scoped to this tool's deps. */
  agent: Agent;
}

// ─── Runtime — what Harness.run() sees ───────────────────────────────────

export interface Runtime {
  /** Pull the session's view of context. Sends history to the model. */
  getEvents(): Promise<SessionUpdate[]>;

  /** Push an event to the session and fan out to observers. */
  update(update: SessionUpdate): Promise<void>;

  /** Fully-assembled system prompt. */
  systemPrompt(): string;

  /**
   * The manifest's `[agent].system_prompt` core only — for harnesses
   * that roll their own assembly (prompt-caching tricks, etc.).
   */
  systemPromptCore(): string;

  listTools(): ToolDescriptor[];
  executeTool(call: ToolCall): Promise<ToolResult>;

  /** Flips when the client cancels. */
  readonly abortSignal: AbortSignal;
}

// ─── Harness ─────────────────────────────────────────────────────────────

export interface TurnResult {
  stopReason: StopReason;
  /** Cumulative usage for this turn. Absent on harnesses that don't track. */
  usage?: TurnUsage;
}

/**
 * Per-turn parameters. Harness owns interpretation. `thinking` is a
 * free-form slot for lab-specific config (Anthropic accepts
 * `{ type: "enabled", budget_tokens: ... }` etc.).
 */
export interface RunParameters {
  /** Force streaming on/off for this turn. */
  stream?: boolean;
  /** Reasoning intensity. Mirrors Anthropic's effort levels. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Raw lab-specific thinking config; wins over `effort` when set. */
  thinking?: unknown;
  /** Override the harness's default max output tokens. */
  maxOutputTokens?: number;
  /** Override the model id for this single call. */
  model?: string;
}

/**
 * ACP-layer capability contribution. Aggregated across harness +
 * session + every resolved tool when an ACP client sends `initialize`.
 * The shape mirrors `AgentCapabilities` from the SDK so contributions
 * compose by deep-merge into the final `initialize` response.
 */
export interface AcpCapabilityContribution {
  /**
   * Prompt-content capabilities (image/audio/embeddedContext). A
   * harness sets these to advertise what `ContentBlock` variants the
   * model can handle inside `session/prompt` requests.
   */
  promptCapabilities?: Partial<
    import("@agentclientprotocol/sdk").PromptCapabilities
  >;
  /**
   * Session lifecycle capabilities (resume/close/fork/list). A
   * session backend sets these to opt into the matching wire methods.
   */
  sessionCapabilities?: Partial<
    import("@agentclientprotocol/sdk").SessionCapabilities
  >;
  /** Whether the agent supports `session/load` (replay history). */
  loadSession?: boolean;
  /** Open bucket for non-spec capabilities. ACP clients ignore unknown keys. */
  experimental?: Record<string, unknown>;
}

export interface SummariseArgs {
  events: SessionUpdate[];
  /** What to do with the events ("produce a tight paragraph", etc.). */
  instruction: string;
  /** The system prompt to use; usually `agent.systemPromptCore`. */
  systemPrompt: string;
  abortSignal?: AbortSignal;
}

// ─── Provider-contributed factories ─────────────────────────────

/**
 * Secret names a factory's product needs. Required names fail boot
 * if missing; optional names load best-effort.
 */
export interface SecretNeeds {
  required?: string[];
  optional?: string[];
}

export interface SessionFactory {
  readonly name: string;
  readonly secrets?: SecretNeeds;
  /**
   * If true, this factory needs a parent agent and cannot be used at
   * the top level (e.g. `fork-of-parent`). Enforced at boot.
   */
  readonly requiresParent?: boolean;
  /**
   * Static ACP capability contribution. Called at `initialize` time
   * without instantiating a session, so factories that need to
   * decide based on config get the same config they would receive in
   * `create()`. Pure: no I/O, no side effects.
   */
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
  /**
   * Static ACP capability contribution. Called at `initialize` time
   * without instantiating a harness, so factories that need to
   * decide based on config get the same config they would receive
   * in `create()`. Pure: no I/O, no side effects.
   */
  acpCapabilities?(config: Record<string, unknown>): AcpCapabilityContribution;
  create(
    config: Record<string, unknown>,
    ctx: FactoryContext,
    secrets: Record<string, string>,
    parent?: Agent,
  ): Promise<Harness> | Harness;
}

/**
 * Per-call context handed to harness / session / provider factories
 * when the runtime instantiates them. Carries the resolved
 * manifest-relative paths, the agent's identity, and the negotiated
 * ACP client capabilities so factories can configure correctly on
 * the first call.
 */
export interface FactoryContext {
  manifestDir: string;
  agentName: string;
  loomVersion: string;
  /**
   * ACP client capabilities, negotiated at `initialize` time (or
   * `DEFAULT_CLIENT_ACP_CAPABILITIES` for SDK-direct / CLI use).
   * Factories see this at construction so they configure once with
   * the full picture.
   */
  clientCapabilities: ClientAcpCapabilities;
  /**
   * Absolute path to a per-agent directory Loom guarantees exists.
   * Sessions / harnesses / Tools factories may keep arbitrary state
   * here (cached tool lists, journals, notes files, PID files).
   * One root per `[agent].storage_id` (or `[agent].name` when not
   * overridden). Convention: namespace by factory name to avoid
   * stomping siblings, e.g. `<storage>/mcp/<handle>/cache.json`.
   */
  storage: string;
}

// ─── Tools (the runtime tool-routing instance) ───────────────────────────

/**
 * Per-tool config from the manifest. Always `Record<string, unknown>`
 * (the string shorthand is parsed into the `provider` field and never
 * reaches the constructor).
 */
export type ToolConfig = Record<string, unknown>;

/**
 * Runtime primitives exposed to a `Tools` instance. Usable after
 * every Tools `init()` has returned — instances must not call these
 * from within their own `init()`.
 */
export interface RuntimePrimitives {
  requestPermission(
    req: Omit<RequestPermissionRequest, "sessionId">,
  ): Promise<RequestPermissionResponse>;
}

export interface InitArgs {
  manifest: AgentManifest;
  /** This Tools instance's config block, or `{}` for native / source-loaded. */
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  factoryContext: FactoryContext;
  runtime: RuntimePrimitives;
}

/**
 * A `Tools` instance — the runtime-layer object a provider's
 * `registerTools` contribution returns from `create()`. Resolves
 * model-facing tool names to executable `Tool` objects.
 */
export interface Tools {
  /**
   * One-time boot setup. Runs in registration order. Don't call
   * `args.runtime` methods from here — they're usable only after
   * every Tools instance's init has returned.
   */
  init?(args: InitArgs): Promise<void> | void;

  /**
   * Try to construct a Tool for this `(name, config)` reference.
   *
   * `capabilities` is the manifest's `[capabilities.<name>]` grant —
   * `"*"` for unrestricted, a per-kind map otherwise, `undefined` when
   * absent. Forward to the tool constructor; tools self-police on it.
   *
   * Return `null` to decline; the runtime will surface the name as
   * unresolved.
   */
  resolveTool(
    name: string,
    config: ToolConfig,
    agent: Agent,
    capabilities: CapabilitySet | undefined,
  ): Promise<Tool | null> | Tool | null;

  /** Cleanup; called when the agent closes. */
  close?(): Promise<void> | void;
}
