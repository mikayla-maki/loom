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

  /**
   * The currently-configured model id. When implemented alongside
   * {@link Harness.models}, lets a client surface the active model
   * (e.g. in an ACP `configOptions` selector) and drive
   * {@link Harness.withModel} to swap.
   *
   * Optional. Harnesses that don't expose a model id (e.g. the
   * scripted `test` harness) may omit it.
   */
  currentModel?(): string;

  /**
   * The set of models this harness can route to. Used by the ACP
   * server to advertise a `model` config option at `session/new`
   * time, and by SDK consumers building model-picker UIs.
   *
   * Implementations may return a static list (built-in well-known
   * model ids), a dynamically-fetched list (the underlying provider's
   * `/models` endpoint), or a mix. Promise-returning so harnesses
   * that hit the network for it don't need to cache eagerly.
   *
   * Optional. Harnesses that don't have a model concept (scripted
   * tests, parent-derived) may omit this; ACP clients will see no
   * model selector for those agents.
   */
  models?(): Promise<HarnessModel[]> | HarnessModel[];

  /**
   * The catalog of tools this harness *can* expose — typically
   * provider-native / server-side tools that the harness dispatches
   * internally (e.g. Anthropic's `web_search`, `web_fetch`, code
   * execution) rather than going through the runtime's `ToolTable`.
   *
   * **Asymmetric with {@link Session.tools}.** These are NOT auto-
   * added to the agent's tool table — the manifest must opt in by
   * listing the tool in `[tools]` with `provider = "<harness-factory-name>"`
   * (e.g. `provider = "anthropic"`). Server tools cost money on the
   * provider's bill and introduce egress; opt-in is the safer
   * default.
   *
   * The resolver uses this catalog to route `[tools.<name>]` bindings
   * whose `provider` value matches the harness's factory name. Tools
   * not in the catalog fall through to the usual `[providers]` /
   * built-in resolution paths.
   *
   * Optional. Harnesses with no server-side tools (e.g. the scripted
   * `test` harness) may omit this; the manifest then has no way to
   * route tools through them.
   */
  availableTools?(): Promise<ToolRef[]> | ToolRef[];

  /**
   * Tool resolver for harness-exposed names. Mirrors
   * {@link Session.resolveTool}; called by the runtime when binding
   * a `[tools.<name>]` entry whose `provider` matches this harness's
   * factory name.
   *
   * Returns a stub {@link Tool} whose `execute()` is generally never
   * called — the harness intercepts dispatch in its own `run()`
   * loop because server-side tools resolve API-side without a
   * client round-trip. The stub's `name`, `description`, and
   * `inputSchema` still matter: they appear in `runtime.listTools()`
   * (used by the system-prompt enumerator) and `loom audit`. A
   * defensive `execute()` should return an `isError: true` result
   * indicating the harness should have intercepted.
   *
   * The `config` argument is the per-tool block from `[tools.<name>]`
   * minus `provider` (e.g. `{ max_uses: 5, allowed_domains: [...] }`).
   * The harness typically stashes it keyed by tool name so its
   * `run()` loop can translate it into the API's native server-tool
   * shape (`WebSearchTool20250305`, etc.).
   *
   * Returning `null` declines the binding; the runtime surfaces it
   * as unresolved.
   */
  resolveTool?(
    name: string,
    config: ToolConfig,
    agent: Agent,
    capabilities: CapabilitySet | undefined,
  ): Promise<Tool | null> | Tool | null;
}

/** One entry in {@link Harness.models}. */
export interface HarnessModel {
  /** Provider-side model id (e.g. `claude-sonnet-4-5`). */
  id: string;
  /** Human-readable label for UIs. Defaults to `id` if omitted. */
  name?: string;
  /** One-line description shown alongside the name. */
  description?: string;
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
 * The runtime triple: a source `AgentManifest` plus its resolved
 * counterparts (harness instance, session instance, loaded system
 * prompt text). Conceptually `Agent === resolved AgentManifest` —
 * the slots the manifest leaves as specs are bound here as concrete
 * instances, and the system prompt is loaded from disk if the
 * manifest pointed at a `{ path }`. Read identity off
 * `agent.manifest.name` / `agent.manifest.description`; the source
 * manifest is also where tools find `tools`, `capabilities`,
 * `providers`, `secrets`, `storageId`, and `manifestPath`.
 */
export interface Agent {
  /**
   * The source manifest this agent was constructed from. Always
   * populated by the runtime; tools and factories may introspect it.
   * The runtime treats the manifest as immutable — do not mutate it.
   * If you need a derived shape, clone first.
   */
  manifest: AgentManifest;
  /**
   * Materialised harness instance. `manifest.harness` may be a
   * `HarnessSpec` *or* a pre-built `Harness`; this is always the
   * constructed instance.
   */
  harness: Harness;
  /**
   * Materialised session instance (possibly the outer `ChainedSession`
   * wrapping a layered config). `manifest.session` may be specs or
   * a `Session` instance; this is always the constructed instance.
   */
  session: Session;
  /**
   * Loaded `[agent].system_prompt` text. `manifest.systemPrompt` may
   * be inline content or `{ path }`; this is always the resolved
   * string. Empty when the manifest omits a system prompt.
   */
  systemPromptCore: string;
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
  /**
   * Optional rendering metadata the harness folds into the wire
   * `tool_call_update`. Tools opt in for nicer ACP-client UX (icon
   * kind, per-invocation title, file locations for click-to-jump,
   * rich content blocks). Ignored by non-ACP consumers — if you
   * never populate this, your tool still works everywhere.
   */
  display?: ToolDisplay;
}

/**
 * Optional ACP-flavoured rendering metadata a tool may attach to
 * its `ToolResult`. Every field is folded into the
 * `tool_call_update` the harness emits for this call.
 *
 * This is the "light ACP" surface: tools opt in to better
 * rendering in IDE clients without taking on the more involved
 * `ClientBridge` integration. See `src/runtime/client-bridge.ts`
 * for the "heavy ACP" surface (route reads/writes/terminals
 * through the client).
 */
export interface ToolDisplay {
  /**
   * Per-invocation title override. e.g. `"bash: \`ls -la\`"`
   * instead of the bare tool name. The harness's initial
   * `tool_call` emits the tool's name as the title; this update
   * replaces it once the tool knows what it's actually doing.
   */
  title?: string;
  /**
   * ACP semantic category — drives icon / placement in the client.
   * One of `"read" | "edit" | "delete" | "move" | "search" |
   * "execute" | "think" | "fetch" | "switch_mode" | "other"`.
   */
  kind?: import("./acp.js").ToolKind;
  /**
   * File locations this call touched. Enables click-to-jump and
   * "follow along" features in IDE clients. Read- and edit-shaped
   * tools should populate this with the paths they accessed.
   */
  locations?: import("./acp.js").ToolCallLocation[];
  /**
   * Rich content blocks the client renders for this tool call.
   * Overrides the harness's default of wrapping `content` (the
   * model-facing string) as a single text block. Use this to embed
   * terminals, diffs, or richer formatted output.
   */
  content?: import("./acp.js").ToolCallContent[];
  /**
   * Raw output surfaced alongside the raw input the harness already
   * emitted on `tool_call`. Free-form JSON; the client may display
   * it in a "raw output" inspector.
   */
  rawOutput?: unknown;
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
  /**
   * Optional bridge to the ACP client driving this agent. Present
   * only when Loom is being driven over ACP (`loom acp serve`); in
   * CLI / SDK-direct / test contexts the bridge is `undefined` and
   * tools fall back to local `node:fs` / `child_process` paths.
   *
   * Used by built-in tools for IDE-aware behavior: `read_file` /
   * `write_file` / `edit_file` route through the client's filesystem
   * so edits surface in the editor; `bash` spawns through
   * `terminal/create` so the user sees a live terminal pane. Third-party tools may
   * opt in by inspecting `client?.<method>` (each method is present
   * iff the client advertised the corresponding capability), but
   * doing so is optional — ignoring this field keeps your tool
   * portable across all four execution modes.
   *
   * See `src/runtime/client-bridge.ts` for the full surface.
   */
  client?: import("../runtime/client-bridge.js").ClientBridge;
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

  /**
   * Emit a tool-call result.
   *
   * Produces two `tool_call_update` events — one pushed into the
   * session (event log), one fanned out via the update sink (ACP
   * client). They differ in exactly one field:
   *
   *   - **`content`**: the session always gets `modelContent` wrapped
   *     as a single text block (what the model replays on the next
   *     turn). The client gets `display.content` when set — e.g.
   *     terminal embeds, diff blocks, file-content blocks — which
   *     aren't replayable by the model but render richly for users.
   *
   * Everything else — `title`, `kind`, `locations`, `rawOutput` —
   * is shared metadata: both consumers see the same values. In
   * particular, `display.rawOutput` lands in the session record too,
   * which lets harnesses read back structured tool payloads on
   * replay (Anthropic server tools rely on this to round-trip
   * `encrypted_content` for citation re-grounding).
   *
   * Use this instead of `update(tool_call_update)` whenever a tool's
   * `content` shape differs between the model (text) and the user
   * (terminal embed, diff). Pure-text tools can either call this or
   * `update()` directly; the former is the cleaner default because
   * it surfaces all the display metadata uniformly.
   */
  emitToolResult(args: {
    toolCallId: import("./acp.js").ToolCallId;
    status: import("./acp.js").ToolCallStatus;
    /** What the model sees on replay. */
    modelContent: string;
    /** Optional rich rendering metadata for ACP clients. */
    display?: ToolDisplay;
  }): Promise<void>;

  /** Flips when the client cancels. */
  readonly abortSignal: AbortSignal;
}

// ─── Harness ─────────────────────────────────────────────────────────────

export interface TurnResult {
  stopReason: StopReason;
  /** Cumulative usage for this turn. Absent on harnesses that don't track. */
  usage?: TurnUsage;
  /**
   * Carrier for a fatal turn error. Present only when
   * `stopReason === "error"`. The harness uses this slot to signal the
   * cause out-of-band; consumers (ACP server, CLI REPL, SDK callers)
   * decide how to surface it. The error must NOT also be emitted as an
   * `agent_message_chunk` — errors are protocol-level events, not
   * assistant utterances that belong in the session log.
   */
  error?: { message: string };
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
  /**
   * Capture the turn's preamble — the assembled system prompt,
   * pulled session events (history), and tool list — immediately
   * before the harness calls the model.
   *
   * Fires exactly once per `prompt()` invocation, after
   * `Session.prepareTurn` and `Session.systemPromptSection` have
   * run but before `Harness.run` dispatches anything. Synchronous
   * or async return; the runtime awaits it before proceeding so
   * downstream consumers can finish their I/O (writing to an audit
   * log, for instance) before the model starts responding.
   *
   * Throwing from this callback aborts the turn with a `stopReason`
   * of `"error"` — if you want best-effort recording, swallow your
   * own exceptions.
   */
  onPreamble?: (preamble: AgentPreamble) => void | Promise<void>;
}

/**
 * Snapshot of what the harness is about to send to the model for a
 * single turn. Surfaced to consumers via {@link RunParameters.onPreamble}
 * and `loom prompt --emit-preamble`; the primary use is per-turn
 * audit logging (Discord bots, agent observability, etc.) where the
 * `text`-mode answer alone doesn't tell the full story.
 *
 * All three fields are read-only snapshots of state the runtime
 * already had to compute to make the API call. None of them mutate
 * the agent.
 */
export interface AgentPreamble {
  /**
   * Fully assembled system prompt the harness will send. Includes
   * the manifest's `[agent].system_prompt`, the agent name /
   * description block, any session-contributed section, and the
   * tool reference — i.e. exactly what `Runtime.systemPrompt()`
   * returns when the harness calls it.
   */
  systemPrompt: string;
  /**
   * Events pulled from the session's view of context, in order.
   * Each is a `SessionUpdate`; the harness converts them into the
   * provider's message shape (Anthropic `MessageParam[]`, OpenAI
   * input items, etc.). Includes the user message that triggered
   * this turn.
   */
  events: SessionUpdate[];
  /**
   * Tools the harness will declare to the model: name,
   * description, JSON schema for inputs. Harness-exposed server
   * tools (Anthropic's `web_search`, etc.) appear here under their
   * stub `Tool` shape.
   */
  tools: ToolDescriptor[];
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
  /**
   * The manifest's `[agent.metadata]` table, verbatim. `{}` when
   * the manifest didn't declare one. Forwarded by the runtime as
   * opt-in passthrough — plugins that don't know about a key
   * should ignore it.
   *
   * See {@link AgentManifest.metadata} for the design intent. The
   * same value is also reachable as `args.manifest.metadata` inside
   * `Tools.init()`, for tool providers that prefer to read it from
   * the manifest directly.
   */
  metadata: Record<string, unknown>;
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
