/**
 * The core interfaces.
 *
 * Loom is a manifest-driven agent runtime. It owns parsing, secrets,
 * the system prompt, and the turn loop. **Tools** are JS objects
 * that a chain of **providers** constructs from manifest entries:
 * each tool reference is `(name, config)`; loom asks each provider
 * in order; the first non-null result wins.
 *
 * Tool capabilities are tool-defined: the shape is whatever the tool
 * needs (paths for a filesystem tool, channels for Discord, buckets
 * for S3). Loom doesn't interpret them. The optional `[sandbox.<name>]`
 * ceiling lets users declare upper bounds; the tool's own
 * `capabilitiesContain` (or a structural default) decides containment.
 *
 * Trust contract: tools are the same trust class as extensions — code
 * the user installed. Loom doesn't sandbox tools at runtime; tools
 * enforce their declared caps themselves. Tools that need real
 * isolation (e.g. shell exec) ship their own sandbox.
 */

import type { SessionUpdate, StopReason, TurnUsage } from "./acp.js";
import type { JSONSchema } from "./schema.js";
import type { AgentManifest } from "./manifest.js";
import type { RunningAgent } from "../sdk/running-agent.js";

// ──────────────────────────────────────────────────────────────────────────
// Session — durable log + memory hooks.
// ────────────────────────────────────────────────────────────────────────────

export interface SessionDescriptor {
  id: string;
  createdAt: string;
  updatedAt: string;
  agentName?: string;
}

/**
 * Session — the agent's view of conversation history plus optional
 * lifecycle participation.
 *
 * The interface is push/pull rather than append/get because sessions
 * compose. A `ChainedSession` holds N children and threads events
 * through them; a `CompactingSession` wraps an inner session and
 * pulls from it on its own schedule. Loom only ever talks to ONE
 * session per agent — composition is internal to whoever the agent
 * uses.
 *
 * Both `push` and `pull` are optional. Undefined means passthrough:
 * `push?` defaults to `[event]` (forward unchanged), `pull?` defaults
 * to returning `below` unchanged. A session that only contributes a
 * `systemPromptSection` (e.g. a skills-catalog session) can omit
 * both.
 */
export interface Session {
  /**
   * An event happened (user input, agent message, tool call, etc.).
   * The session may store, transform, drop, or fan-out. The return
   * value is the events to forward to the next stage in any
   * composition pattern. For top-level sessions Loom ignores the
   * return; for composed sessions (e.g. inside a `ChainedSession`)
   * it threads through the chain.
   *
   *   - return [event]   → forward unchanged (default if undefined)
   *   - return [...]     → transform / fan-out
   *   - return []        → drop (terminal or filter)
   */
  push?(event: SessionUpdate): Promise<SessionUpdate[]>;

  /**
   * Return the session's view of the context window. `below` is what
   * an upstream stage produced (empty for the outer call from Loom).
   * The session may augment, transform, or replace it.
   *
   * Default when undefined: passthrough (return `below` unchanged).
   */
  pull?(below: SessionUpdate[]): Promise<SessionUpdate[]>;

  /**
   * Optional per-turn hook. Loom calls this once per turn, after the
   * user's message has been pushed and before the runtime is built.
   * The session receives the owning `Agent` — the runtime triple
   * (harness + session + identity).
   *
   * Use cases:
   *   - compaction (a wrapping session pulls its inner, summarises,
   *     caches the result for subsequent pulls)
   *   - memory retrieval (set up state for `systemPromptSection`)
   *   - skills scanning (pick up newly-added markdown files)
   *   - any per-turn reflection
   */
  prepareTurn?(agent: Agent): Promise<void> | void;

  /**
   * Optional: contribute a section to the assembled system prompt.
   * Multiple sessions composed via `ChainedSession` have their
   * contributions concatenated in order.
   *
   * Called once per turn, *after* `prepareTurn` (so any state set up
   * there is visible).
   */
  systemPromptSection?(agent: Agent): string | Promise<string>;

  /**
   * Optional: tools this session brings into scope. Loom unions all
   * sessions' tools (composed or not) into the agent's tool table at
   * boot, alongside the manifest's top-level `[tools]`.
   */
  tools?(): Promise<ToolRef[]> | ToolRef[];

  /**
   * Optional: sub-agents this session declares it may spawn. Trusted
   * self-declaration; the point is auditability via `loom audit`,
   * not runtime enforcement.
   */
  dependencies?: { subagents?: AgentManifest[] };

  /** Optional: providers that manage many sessions. */
  list?(): Promise<SessionDescriptor[]>;
  resume?(id: string): Promise<Session>;

  /** Release any resources (file handles, etc.). */
  close?(): Promise<void>;
}

/** A `(name, config)` tool reference, as it appears in manifests. */
export interface ToolRef {
  name: string;
  config: ToolConfig;
}

/**
 * `Agent` — the runtime triple that defines an agent: its harness
 * (compute), its session (memory), and its identity (system-prompt
 * core, name, description). Plain data; no methods.
 *
 * Three roles:
 *
 *   1. **Self-ref.** A tool / session sees its own owning agent via
 *      `ctx.agent` (tools) or the per-turn argument to `prepareTurn` /
 *      `systemPromptSection` (sessions). Both let the holder reach the
 *      live harness and session.
 *
 *   2. **Parent ref.** When spawning a sub-agent, the caller passes
 *      its own `Agent` as `runAgent(submanifest, { parent }).` Child
 *      `HarnessFactory` / `SessionFactory.create()` receive it as
 *      their optional 4th argument; most factories ignore it. The
 *      parent-derived ones (`fork-of-parent`, `small-model-of-parent`)
 *      build new state from it.
 *
 *   3. **Audit closure.** A static walk of the dependency tree visits
 *      every `Tool.dependencies.subagents` and
 *      `Session.dependencies.subagents`, recursively, with the parent
 *      `Agent` available conceptually at each step.
 *
 * Why pass the harness/session directly rather than wrapping: Loom is
 * self-similar. A session that wants to summarise calls
 * `summarise(agent.harness, ...)`. A child harness that needs the
 * parent's API key reads it off `parent.harness` directly.
 */
export interface Agent {
  /** The agent's harness — the compute layer. */
  harness: Harness;
  /** The agent's session — the memory layer. */
  session: Session;
  /** The unassembled `[agent].system_prompt` content — the identity layer. */
  systemPromptCore: string;
  /** Agent name (from manifest). */
  agentName: string;
  /** Agent description, if the manifest set one. */
  agentDescription?: string;
  /**
   * Spawn a sub-agent.
   *
   * String form: looked up by `manifest.name` in the calling code's
   * own `dependencies.subagents` (a tool's deps when called from
   * `ctx.agent.spawnSubagent(...)`; a session's deps when called
   * from a session hook). Throws `ResolutionError` if the name
   * isn't declared — by design; the audit walk is the trust
   * artifact, and silent fall-through to a global registry would
   * defeat it.
   *
   * Manifest form: runs the supplied manifest inline. Use sparingly
   * — callers that always spawn the same shape should declare it
   * in `dependencies.subagents` so audit can see it.
   *
   * Either path auto-fills `parent` with this Agent. The child runs
   * standalone (its own provider chain, its own tool registry); the
   * parent's tools are NOT shared. Cancellation does not cascade —
   * if you want the child to die when the parent's turn aborts,
   * plumb an AbortSignal through.
   *
   * Optional only because Agent literals can be constructed without
   * a deps scope (e.g. `RunAgentOptions.parent` from an SDK consumer
   * who hand-built the ref, or the Agent threaded into
   * `Provider.resolveTool` at boot before any tool exists). In
   * runtime-supplied self-refs — `ctx.agent` inside a tool, the
   * `agent` arg to `prepareTurn` / `systemPromptSection` — it's
   * always present.
   */
  spawnSubagent?(nameOrManifest: string | AgentManifest): Promise<RunningAgent>;
}

// ────────────────────────────────────────────────────────────────────────────
// Tool — a JS object that the model calls. Constructed by a provider.
// ────────────────────────────────────────────────────────────────────────────

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export interface ToolCall {
  /** A unique-per-turn id for tying calls to their results. */
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  /** Stringified content the model will see. */
  content: string;
  /** Whether the tool exited non-zero / failed. */
  isError?: boolean;
}

/**
 * Severity of an audit finding.
 *
 *   ok      — expected, surfaced for visibility (e.g. "sandbox-exec
 *             available; structured grant will engage")
 *   warning — degraded but functional (e.g. "running unsandboxed; the
 *             grant doesn't constrain anything at runtime")
 *   error   — the tool will fail or behave unsafely under the current
 *             configuration (e.g. "sandbox-exec not found; bash will
 *             refuse to run with structured grant")
 */
export type AuditSeverity = "ok" | "warning" | "error";

export interface AuditFinding {
  severity: AuditSeverity;
  message: string;
  /** Optional: human-readable suggestion that would resolve the finding. */
  remediation?: string;
}

export interface Tool extends ToolDescriptor {
  /**
   * Capability KINDS this tool MUST be granted to function. Static —
   * declared once on the class, independent of runtime state. The boot
   * guard checks every required kind is present in the manifest's
   * `[capabilities.<name>]` grant (or that the grant is `"*"`); a tool
   * with an unsatisfied requirement fails to construct.
   *
   * Examples:
   *   bash:        requires = ["subprocess"]
   *   read_file:   requires = ["paths"]
   *   s3:          requires = ["buckets"]
   *   echo:        requires = [] / undefined
   */
  requires?: string[];

  /**
   * Capability KINDS this tool MAY use if granted. Optional kinds
   * inform `loom audit` and (in the case of bash) sandbox profile
   * derivation, but boot doesn't fail when they're absent. Tools that
   * read an optional kind at execute time should fall back gracefully
   * when the manifest didn't grant it.
   *
   *   bash:  optional = ["paths", "network", "env"]
   */
  optional?: string[];

  /**
   * Granted capability set, derived at construction from
   * `manifest.capabilities[<this tool's name>]`. Tools self-police at
   * execute time by reading this field and rejecting calls that
   * exceed it; tools also derive their model-facing `description` and
   * `inputSchema` from this (so a tool's surface is partially
   * determined by what it was granted).
   *
   * `"*"` means whole-tool unrestricted. A per-kind map grants only
   * the listed kinds; absent kinds are denied. `{}` grants nothing.
   */
  capabilities?: import("./manifest.js").CapabilitySet;

  /** Secret names this tool wants. Loom resolves the closure at boot. */
  secrets?: SecretNeeds;

  /**
   * Optional environment audit. Called by `loom audit` to surface
   * runtime preconditions — things like "sandbox-exec is missing,
   * so structured grants won't actually engage," or "the granted
   * directory doesn't exist on disk." The static tree (manifest
   * coherence) and these findings (machine readiness) appear side
   * by side.
   *
   * MUST be read-only and side-effect-free — audit shouldn't open
   * connections, prompt the user, or mutate anything. Cheap inspections
   * only (`fs.access`, env var reads, `which`-style binary detection).
   */
  audit?(): Promise<AuditFinding[]> | AuditFinding[];

  /**
   * Optional: sub-agents this tool declares it may spawn. Trusted
   * self-declaration; the point is auditability via `loom audit`, not
   * runtime enforcement. A tool that spawns a child it didn't declare
   * is misbehaving — trust violation by the tool author, not a Loom
   * bug.
   *
   * `ctx.spawnSubagent(name)` looks up by `manifest.name` in this
   * field; passing a manifest inline bypasses the lookup. Either path
   * auto-fills `parent` with the tool's own `ctx.agent`.
   */
  dependencies?: { subagents?: AgentManifest[] };

  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Per-call context. Built by the runtime at every dispatch.
 */
export interface ToolContext {
  /** Per-tool secret slice; already filtered to this tool's allowlist. */
  secrets: Record<string, string>;
  /** Current turn's abort signal. Tools should observe it for long ops. */
  abortSignal: AbortSignal;
  /**
   * Ask the SDK consumer for user consent. Returns `{ decision: "deny" }`
   * if no handler is registered.
   */
  requestPermission(
    req: import("./permissions.js").PermissionRequest,
  ): Promise<import("./permissions.js").PermissionResult>;
  /**
   * The owning agent (the agent this tool is part of). The runtime
   * supplies an Agent whose `spawnSubagent` is bound to this tool's
   * `dependencies.subagents` — so `ctx.agent.spawnSubagent("name")`
   * looks up in the calling tool's own deps.
   */
  agent: Agent;
}

// ──────────────────────────────────────────────────────────────────────────
// Runtime — what the Harness calls during a turn.
// ──────────────────────────────────────────────────────────────────────────

export interface Runtime {
  /**
   * Pull the session's view of the context window. Calls
   * `session.pull([])`; composed sessions thread the chain
   * internally. Returns the events the harness should send to the
   * model as conversation history.
   */
  getEvents(): Promise<SessionUpdate[]>;

  /**
   * Push an event to the session and fan it out to observers. The
   * session may store, transform, or drop; the update sink sees the
   * original event regardless.
   */
  update(update: SessionUpdate): Promise<void>;

  /** The fully-assembled system prompt (default path). */
  systemPrompt(): string;

  /**
   * Just the manifest-owned core (the `[agent].system_prompt` field after
   * path resolution) — exposed so a Harness extension that needs to roll
   * its own assembly (provider-specific formatting, prompt-caching tricks)
   * can read it separately and reuse `listTools()`.
   */
  systemPromptCore(): string;

  /** All tools available to the model. */
  listTools(): ToolDescriptor[];

  /** Execute a tool call. */
  executeTool(call: ToolCall): Promise<ToolResult>;

  /** AbortSignal for the current turn — flips when the client cancels. */
  readonly abortSignal: AbortSignal;
}

// ────────────────────────────────────────────────────────────────────────────
// Harness — owns the loop for a single turn.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Result of a single turn. Carries the stop reason and (optional) per-turn
 * cumulative usage from any harness that tracks it. Sessions and clients
 * read both off `RunningAgent.prompt()`.
 */
export interface TurnResult {
  stopReason: StopReason;
  /** Cumulative usage for this turn. Absent on harnesses that don't track. */
  usage?: TurnUsage;
}

/**
 * Per-turn parameters. The harness owns interpretation; loom passes the
 * struct through unchanged. Fields are lab-aware where useful (e.g.
 * Anthropic's native `effort` levels) and a free-form `thinking` slot
 * lets callers hand the harness raw lab-specific config when they need
 * something the typed fields don't cover.
 */
export interface RunParameters {
  /**
   * Whether to stream tokens. Most harnesses default to true; setting
   * false here forces non-streaming for this turn.
   */
  stream?: boolean;
  /**
   * Reasoning intensity. Maps directly to Anthropic's
   * `output_config.effort` (which has the same five levels). Other
   * harnesses translate or ignore.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Raw lab-specific thinking/reasoning config. Anthropic accepts
   * `{ type: "enabled", budget_tokens: … }`, `{ type: "disabled" }`, or
   * `{ type: "adaptive" }`. Forwarded as-is. When both `effort` and
   * `thinking` are set, the harness picks one (Anthropic prefers
   * explicit `thinking`; effort falls through to a default budget).
   */
  thinking?: unknown;
  /** Override the harness's default `max_tokens` for output. */
  maxOutputTokens?: number;
  /**
   * Override the harness's default model id for this single call.
   * Useful for routing ("this turn is light, use haiku").
   */
  model?: string;
}

export interface Harness {
  /**
   * Run a single turn to completion. The harness should pull events from the
   * runtime, call the model, dispatch tool calls, and return a TurnResult.
   * It SHOULD honor `runtime.abortSignal` and stop promptly when aborted.
   *
   * `params` is optional; harnesses that ignore it behave as before.
   */
  run(runtime: Runtime, params?: RunParameters): Promise<TurnResult>;

  /**
   * Optional: lab-aware capabilities the harness can implement when its
   * provider supports them natively (or coerce out of the existing wire
   * format). Sessions and other consumers call these directly; when a
   * harness doesn't implement a method, the relevant Loom helper
   * synthesises it via `run()` (e.g. `summariseViaRun`).
   *
   * Discipline: a method earns a place here when there's a clear
   * cost/perf/quality win over composing `run()`. Otherwise prefer the
   * helper.
   */

  /**
   * Run a one-shot, tool-free summarisation. Returns the assembled
   * assistant text — does not write to any session. When omitted, Loom
   * provides a default that drives `run()` against a synthetic Runtime.
   */
  summarise?(args: SummariseArgs): Promise<string>;
}

/** Arguments to `Harness.summarise` (and the matching helper). */
export interface SummariseArgs {
  /** Conversation history to compress. */
  events: SessionUpdate[];
  /** What to do with the events ("produce a tight paragraph", etc.). */
  instruction: string;
  /**
   * The system prompt the model should see. Callers usually supply the
   * agent's `systemPromptCore` plus any session-specific framing.
   */
  systemPrompt: string;
  /** Optional abort signal. Defaults to never-aborted. */
  abortSignal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────────────────
// Extension factories.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Secrets a factory's product needs at runtime. The closure of all
 * declared `required` names is validated at boot; missing required
 * secrets fail the run. `optional` names load best-effort.
 */
export interface SecretNeeds {
  required?: string[];
  optional?: string[];
}

export interface SessionFactory {
  readonly name: string;
  readonly secrets?: SecretNeeds;
  /**
   * If true, this factory cannot run at the top level: it needs a
   * parent agent (e.g. `fork-of-parent` reads parent events to seed
   * its own log). Loom enforces this at boot — a top-level manifest
   * that selects such a factory fails with a clear error before
   * `create()` runs.
   */
  readonly requiresParent?: boolean;
  create(
    config: Record<string, unknown>,
    ctx: ExtensionContext,
    secrets: Record<string, string>,
    parent?: Agent,
  ): Promise<Session> | Session;
}

export interface HarnessFactory {
  readonly name: string;
  readonly secrets?: SecretNeeds;
  /**
   * If true, this factory cannot run at the top level: it needs a
   * parent agent (e.g. `small-model-of-parent` reuses the parent's
   * API key + a configured smaller model). Loom enforces this at
   * boot — a top-level manifest that selects such a factory fails
   * with a clear error before `create()` runs.
   */
  readonly requiresParent?: boolean;
  create(
    config: Record<string, unknown>,
    ctx: ExtensionContext,
    secrets: Record<string, string>,
    parent?: Agent,
  ): Promise<Harness> | Harness;
}

export interface ExtensionContext {
  /** Directory of the agent.toml that loaded this extension. */
  manifestDir: string;
  /** A read-only snapshot of the agent's name. */
  agentName: string;
  /** Loom version. */
  loomVersion: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Provider — turns (name, config) tool references into Tool objects.
//
// Loom maintains a chain of providers: SDK-supplied → extension-loaded →
// native (always last). For each tool reference in the manifest's
// top-level `[tools]`, loom asks providers in order; the first non-null
// result wins. If no provider claims a name, the run fails at boot.
//
// The native provider (in `src/extensions/provider/native.ts`) ships a
// fixed map of builtin tools (`bash`, `read_file`, etc.). Extensions
// register additional `(name, config) → Tool` builders the same way —
// they're not privileged, just registered earlier.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Per-tool config value from a manifest entry. Loom doesn't interpret
 * it; providers do. Capabilities do NOT live here — they ride a
 * separate channel (the manifest's `[capabilities]` table) and arrive
 * at the tool's constructor as a separate argument. Tool config is
 * for runtime defaults: provider hint, region, timeouts, server URL.
 *
 * Common shapes:
 *   "builtin"                              — string-shorthand
 *   { provider = "mcp", server = "..." }   — provider hint + config
 *   { region = "us-west-2", retries = 3 }  — tool-specific defaults
 */
export type ToolConfig = string | Record<string, unknown>;

/**
 * Loom's runtime primitives, exposed to providers so they can wire tools
 * to them. Methods are usable AFTER every provider's `init()` has
 * returned.
 *
 * Note: providers don't get the owning `Agent` here. The Agent is
 * passed directly to `resolveTool(name, config, agent)` so providers
 * that want to capture it at tool-construction time can; providers
 * that don't, ignore the arg. Tools always see the agent at dispatch
 * via `ctx.agent`, regardless of what their provider did.
 */
export interface RuntimePrimitives {
  requestPermission(
    req: import("./permissions.js").PermissionRequest,
  ): Promise<import("./permissions.js").PermissionResult>;
}

export interface ProviderInitArgs {
  manifest: AgentManifest;
  /** This provider's own `[extensions.<name>]` block, or `{}` for native. */
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  extensionContext: ExtensionContext;
  /** Loom's runtime primitives. Stash and call later from tool execute. */
  runtime: RuntimePrimitives;
}

export interface Provider {
  /**
   * Optional setup. Called once at boot, in registration order. Providers
   * should not call methods on `args.runtime` from within `init()` — the
   * primitives become usable after every provider's init has returned.
   */
  init?(args: ProviderInitArgs): Promise<void> | void;

  /**
   * Try to construct a Tool for this `(name, config)` reference. Return
   * null to pass the entry to the next provider in the chain.
   *
   * `agent` is the owning Agent (the one this provider is resolving
   * tools for). Plain data — no `spawnSubagent` here, since the
   * provider doesn't know which tool's scope it'd belong to. Use it
   * for tool-construction-time wiring (capturing the harness ref,
   * session ref, identity); tools see the agent at dispatch via
   * `ctx.agent`, which DOES have a tool-scoped `spawnSubagent`.
   *
   * `capabilities` is the manifest's `[capabilities.<name>]` grant for
   * this tool, or `undefined` when the manifest has no entry. Providers
   * forward it to the tool constructor; tools store it for self-policing
   * and derive description / input schema from it. `"*"` means
   * whole-tool unrestricted; an object is a per-kind map; absent kinds
   * are denied.
   */
  resolveTool(
    name: string,
    config: ToolConfig,
    agent: Agent,
    capabilities: import("./manifest.js").CapabilitySet | undefined,
  ): Promise<Tool | null> | Tool | null;

  /** Cleanup; called when the agent closes. */
  close(): Promise<void> | void;
}

export interface ProviderFactory {
  readonly name: string;
  readonly secrets?: SecretNeeds;
  /** Construct a fresh provider instance. The instance's `init()` runs side effects. */
  create(): Provider;
}
