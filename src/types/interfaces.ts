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

import type { SessionUpdate, StopReason } from "./acp.js";
import type { JSONSchema } from "./schema.js";
import type { AgentManifest, SkillManifest } from "./manifest.js";

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

  /** Optional: providers that manage many sessions. */
  list?(): Promise<SessionDescriptor[]>;
  resume?(id: string): Promise<Session>;

  /** Release any resources (file handles, etc.). */
  close?(): Promise<void>;
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
}

/** Single entry returned by `ctx.searchSkills()`. */
export interface SkillSummary {
  name: string;
  description: string;
  /** Tool names this skill brings into scope. */
  toolNames: string[];
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

export interface Harness {
  /**
   * Run a single turn to completion. The harness should pull events from the
   * runtime, call the model, dispatch tool calls, and return a StopReason.
   * It SHOULD honor `runtime.abortSignal` and stop promptly when aborted.
   */
  run(runtime: Runtime): Promise<StopReason>;
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
  create(
    config: Record<string, unknown>,
    ctx: ExtensionContext,
    secrets: Record<string, string>,
  ): Promise<Session> | Session;
}

export interface HarnessFactory {
  readonly name: string;
  readonly secrets?: SecretNeeds;
  create(
    config: Record<string, unknown>,
    ctx: ExtensionContext,
    secrets: Record<string, string>,
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
   */
  resolveTool(
    name: string,
    config: ToolConfig,
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
