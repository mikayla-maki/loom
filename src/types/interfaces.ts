/**
 * The core interfaces.
 *
 * Loom is a manifest-driven agent runtime. It owns parsing, secrets,
 * the system prompt, the turn loop, and skills. **Tools** are JS
 * objects that a chain of **providers** constructs from manifest
 * entries: each tool reference is `(name, config)`; loom asks each
 * provider in order; the first non-null result wins.
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
import type { AgentManifest, SkillManifest } from "./manifest.js";
import type { RunningAgent } from "../sdk/running-agent.js";

// ────────────────────────────────────────────────────────────────────────────
// Session — durable log + optional skill contributions.
// ────────────────────────────────────────────────────────────────────────────

export interface SessionDescriptor {
  id: string;
  createdAt: string;
  updatedAt: string;
  agentName?: string;
}

export interface Session {
  /** Append a single update to the durable log. */
  append(update: SessionUpdate): Promise<void>;

  /** Return events `[from, to)` (defaults: from=0, to=length). */
  getEvents(from?: number, to?: number): Promise<SessionUpdate[]>;

  /** Number of stored events. */
  count(): Promise<number>;

  /**
   * Optional: skills this session contributes (memory architecture). The
   * default is to contribute none. Sessions that need agent participation
   * (e.g. compaction prompts) ship the relevant skills here.
   */
  skills?(): Promise<SkillManifest[]> | SkillManifest[];

  /**
   * Optional per-turn hook. Loom calls this once per turn, after the
   * user's message has been appended and before the runtime is built.
   * The session receives the owning `Agent` — the runtime triple
   * (harness + session + identity).
   *
   * This is where a session does work that needs the harness:
   *   - compaction (drive `summarise(agent.harness, ...)` and rewrite the log)
   *   - memory retrieval (set up state for `systemPromptSection`)
   *   - any per-turn reflection
   *
   * Loom is self-similar: a session that wants RLM-style sub-agents
   * builds them with `runAgent(submanifest, { parent: agent })`,
   * reusing the parent's harness (and its secrets/config) for free.
   *
   * Sessions that don't need agent participation — plain durable logs —
   * omit this method.
   */
  prepareTurn?(agent: Agent): Promise<void> | void;

  /**
   * Optional: contribute a section to the assembled system prompt.
   *
   * Loom owns the system prompt, but a session legitimately has
   * identity-level content the model needs to see — retrieved memories,
   * accumulated user preferences, scoped instructions. The returned
   * string lands at the end of the assembled prompt, closest to the
   * conversation history (recency favours fresh memories).
   *
   * Called once per turn, *after* `prepareTurn` (so any state set up
   * there is visible). The same `Agent` ref is passed; sessions that
   * need only identity (`agent.systemPromptCore`) can read it here
   * without implementing `prepareTurn`.
   */
  systemPromptSection?(agent: Agent): string | Promise<string>;

  /**
   * Optional: sub-agents this session declares it may spawn. Trusted
   * self-declaration; the point is auditability via `loom audit`, not
   * runtime enforcement. A session that spawns a child it didn't
   * declare is misbehaving — it's a trust violation by the session
   * author, not a Loom bug.
   *
   * The session has access to its own `dependencies` field; to spawn
   * by name it does the lookup itself and calls
   * `runAgent(submanifest, { parent: agent })`.
   */
  dependencies?: { subagents?: AgentManifest[] };

  /** Optional: providers that manage many sessions. */
  list?(): Promise<SessionDescriptor[]>;
  resume?(id: string): Promise<Session>;

  /** Release any resources (file handles, etc.). */
  close?(): Promise<void>;
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

export interface Tool extends ToolDescriptor {
  /**
   * Capability footprint this tool advertises. Shape is tool-specific:
   * `{ paths: ["./"] }` for a filesystem tool, `{ buckets: [...] }` for
   * S3, etc. Loom doesn't interpret the shape — it's a black box used
   * for audit and (when `[sandbox.<name>]` is present) for the
   * boot-time ceiling check.
   *
   * Tools self-police at execute time: they read their own capabilities
   * field and decide what to allow. Loom does not enforce caps at runtime.
   */
  capabilities?: unknown;

  /** Secret names this tool wants. Loom resolves the closure at boot. */
  secrets?: SecretNeeds;

  /**
   * Optional containment check for the [sandbox.<name>] ceiling test.
   * Returns true if `subset` is allowed given `superset` as the ceiling.
   * When omitted, loom uses a structural default (deep-subset on plain
   * objects/arrays, equality on primitives).
   */
  capabilitiesContain?(superset: unknown, subset: unknown): boolean;

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
  /** Read-only enumeration of skills available to this agent. */
  searchSkills(query?: string): Promise<SkillSummary[]>;
  /**
   * The owning agent (the agent this tool is part of). The runtime
   * supplies an Agent whose `spawnSubagent` is bound to this tool's
   * `dependencies.subagents` — so `ctx.agent.spawnSubagent("name")`
   * looks up in the calling tool's own deps.
   */
  agent: Agent;
}

/** Single entry returned by `ctx.searchSkills()`. */
export interface SkillSummary {
  name: string;
  description: string;
  /** Tool names this skill brings into scope. */
  toolNames: string[];
  /**
   * Path the model passes to `read_file` to fetch the skill's full
   * SKILL.md. For on-disk skills this is a real fs path; for inline
   * skills it's the synthetic `loom-skills:<name>/SKILL.md` URI that
   * `read_file` resolves from memory.
   */
  path: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Runtime — what the Harness calls during a turn.
// ────────────────────────────────────────────────────────────────────────────

export interface SkillDescriptor {
  name: string;
  description: string;
  body: string;
  /** The tool names this skill brings into scope. */
  toolNames: string[];
  /**
   * The path the model uses to fetch this skill's SKILL.md via
   * `read_file`. Real fs path for on-disk skills, synthetic
   * `loom-skills:<name>/SKILL.md` for inline skills.
   */
  path: string;
}

export interface Runtime {
  /** Read the durable session log. */
  getEvents(from?: number, to?: number): Promise<SessionUpdate[]>;

  /** Append + fan-out an update. */
  update(update: SessionUpdate): Promise<void>;

  /** The fully-assembled system prompt (default path). */
  systemPrompt(): string;

  /**
   * Just the manifest-owned core (the `[agent].system_prompt` field after
   * path resolution) — exposed so a Harness extension that needs to roll
   * its own assembly (provider-specific formatting, prompt-caching tricks)
   * can read components separately and reuse `listSkills()` / `listTools()`.
   */
  systemPromptCore(): string;

  /** All skills (from manifest + session contributions) with their tool names. */
  listSkills(): SkillDescriptor[];

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
// native (always last). For each tool reference in the manifest (top-level
// `[tools]` plus every skill's `requires:`), loom asks providers in order;
// the first non-null result wins. If no provider claims a name, the run
// fails at boot.
//
// The native provider (in `src/extensions/provider/native.ts`) ships a
// fixed map of builtin tools (`bash`, `read_file`, etc.). Extensions
// register additional `(name, config) → Tool` builders the same way —
// they're not privileged, just registered earlier.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Per-tool config value from a manifest entry. Loom doesn't interpret
 * it; providers do. Common shapes:
 *
 *   "builtin"                       — string-shorthand
 *   { mcp = true }                  — object with provider hint
 *   { paths = ["./"] }              — tool-specific config
 *   { capabilities = { ... } }      — explicit cap declaration
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
  searchSkills(query?: string): Promise<SkillSummary[]>;
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
   */
  resolveTool(
    name: string,
    config: ToolConfig,
    agent: Agent,
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
