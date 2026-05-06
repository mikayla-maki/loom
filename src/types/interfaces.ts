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
}

export interface Runtime {
  /** Read the durable session log. */
  getEvents(from?: number, to?: number): Promise<SessionUpdate[]>;

  /** Append + fan-out an update. */
  update(update: SessionUpdate): Promise<void>;

  /** The fully-assembled system prompt (default path). */
  systemPrompt(): string;

  /** Just the resolved [agent].identity content. */
  identity(): string;

  /** All skills (manifest + session-contributed) with their tool names. */
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
