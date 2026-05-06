/**
 * The four core interfaces.
 *
 * Each one corresponds to a "resource" in the manifest model. The Glass
 * runtime wires implementations of these together.
 */

import type { SessionUpdate, StopReason } from "./acp.js";
import type { JSONSchema } from "./schema.js";
import type { SkillManifest } from "./manifest.js";

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
// Tool — a sandboxed, schema-described executable.
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
  execute(input: unknown, secrets: Record<string, string>): Promise<ToolResult>;
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
   * When true, the runtime renders this skill's body as part of the core
   * system-prompt section rather than as an entry under `# Available Skills`.
   * Used by the auto-loaded `core` builtin so its tools feel always-on.
   */
  inlineInSystemPrompt?: boolean;
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

  /** All skills (manifest + session-contributed) with their tool names. */
  listSkills(): SkillDescriptor[];

  /** All tools available to the model. */
  listTools(): ToolDescriptor[];

  /** Execute a tool call. */
  executeTool(call: ToolCall): Promise<ToolResult>;

  /** AbortSignal for the current turn — flips when the client cancels. */
  readonly abortSignal: AbortSignal;

  /**
   * Request a capability decision from the SDK consumer. Returns the
   * handler's reply, or `{ decision: "deny" }` if no handler is registered.
   * Builtin tools that want to expand the agent's scope (e.g. `add_skill`)
   * route their consent flow through this method.
   */
  requestPermission(
    req: import("./permissions.js").PermissionRequest,
  ): Promise<import("./permissions.js").PermissionResult>;
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

// ────────────────────────────────────────────────────────────────────────────
// Extension factories.
// ────────────────────────────────────────────────────────────────────────────

export interface SessionFactory {
  /** Bare-name the runtime resolves to find this extension. */
  readonly name: string;
  create(config: Record<string, unknown>, ctx: ExtensionContext): Promise<Session> | Session;
}

export interface HarnessFactory {
  readonly name: string;
  create(config: Record<string, unknown>, ctx: ExtensionContext): Promise<Harness> | Harness;
}

export interface ExtensionContext {
  /** Directory of the agent.toml that loaded this extension. */
  manifestDir: string;
  /** A read-only snapshot of the agent's name. */
  agentName: string;
  /** Glass version. */
  glassVersion: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Provider — a pluggable resolver for tools and/or skills.
//
// The resolver consults provider instances *before* falling back to the
// LocalRegistry / builtins. This is how a future MCP extension would
// surface MCP-server tools as Glass tools without anything ever existing
// on disk: at boot the provider connects to the server(s), and resolveTool
// returns a synthetic ToolManifest plus a pre-built Tool that proxies to
// the MCP server.
//
// Providers can also resolve skills (and skills can come bundled with
// already-instantiated tools — useful when the provider's tools share a
// connection or auth scope).
// ────────────────────────────────────────────────────────────────────────────

import type { ToolManifest } from "./manifest.js";

/** Result of provider resolution — either a path on disk, or a synthetic in-memory bundle. */
export type ProviderToolResolution =
  | { kind: "path"; path: string }
  | { kind: "synthetic"; manifest: ToolManifest; tool: Tool };

export type ProviderSkillResolution =
  | { kind: "path"; path: string }
  | {
      kind: "synthetic";
      manifest: SkillManifest;
      /** Map of model-facing tool name → resolved tool. */
      tools: Map<string, { manifest: ToolManifest; tool: Tool }>;
    };

export interface Provider {
  /** Optional: resolve a tool by model-facing name. Return null to pass. */
  resolveTool?(
    name: string,
  ): Promise<ProviderToolResolution | null> | ProviderToolResolution | null;

  /** Optional: resolve a skill by name. Return null to pass. */
  resolveSkill?(
    name: string,
  ): Promise<ProviderSkillResolution | null> | ProviderSkillResolution | null;

  /** Optional: enumerate all currently-available tools/skills (for audit / listing). */
  list?(): Promise<{ skills?: string[]; tools?: string[] }> | { skills?: string[]; tools?: string[] };

  /** Optional cleanup. Called when the agent closes. */
  close?(): Promise<void>;
}

export interface ProviderFactory {
  /** Bare-name the runtime resolves to find this extension. */
  readonly name: string;
  create(config: Record<string, unknown>, ctx: ExtensionContext): Promise<Provider> | Provider;
}
