/**
 * `loom prompt` — one-shot prompt execution + format-specific
 * renderers.
 *
 * Three modes, selected with `--format`:
 *
 *   text   (default) Final agent message → stdout. Pipe-friendly.
 *                    The CLI quietly augments [agent].system_prompt
 *                    with a note that only the final message is
 *                    surfaced. Tool calls, thoughts, and intermediate
 *                    commentary are dropped; non-text content blocks
 *                    in the final message land on stderr as
 *                    `[image: ...]` placeholders.
 *   trace            Coalesced labelled trace for debug. Tool calls,
 *                    agent text, and the stop reason are rendered one
 *                    line per logical unit (not per chunk).
 *   jsonl            One `SessionUpdate` per line, raw ACP shape.
 *
 * Exit codes track the turn's stop reason:
 *   end_turn  → 0
 *   max_turns → 1
 *   cancelled → 130   (SIGINT convention)
 *   error     → 1     (with message to stderr)
 */

import { runAgent, type OnMissingSecret } from "../sdk/run-agent.js";
import type { RunningAgent } from "../sdk/running-agent.js";
import type {
  ContentBlock,
  SessionUpdate,
  StopReason,
  ToolCallContent,
} from "../types/acp.js";
import type { AgentManifest } from "../types/manifest.js";
import type { AuditFinding } from "../types/interfaces.js";
import type { PermissionHandler } from "../types/permissions.js";

export type PromptFormat = "text" | "trace" | "jsonl";

/**
 * Hardcoded preamble appended to [agent].system_prompt when running
 * `loom prompt --format=text`. Tells the model that only its final
 * message — the text after its last tool call — reaches the user.
 *
 * Kept short and verbatim; no template engine, no customisation hook.
 */
export const TEXT_MODE_PROMPT_AUGMENTATION =
  "You are being invoked in text-output mode. Only " +
  "your final message — the text after your last tool call, before " +
  "the turn ends — is shown to the user. Any text before tool calls " +
  "is invisible. Be concise; put the answer in your last message.";

/**
 * Map a `StopReason` to a Unix-conventional process exit code.
 *
 * `end_turn` is a clean completion → 0. `cancelled` follows the
 * SIGINT convention → 130. The various "the agent didn't finish"
 * reasons (`max_tokens`, `max_turn_requests`, `refusal`) and Loom's
 * internal `error` sentinel all map to 1.
 */
export function exitCodeForStopReason(reason: StopReason): number {
  switch (reason) {
    case "end_turn":
      return 0;
    case "cancelled":
      return 130;
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
    case "error":
      return 1;
    default:
      return 1;
  }
}

/**
 * Append the text-mode preamble to whatever the manifest already
 * declares for `[agent].system_prompt`. Pure: returns a new manifest
 * with the systemPrompt rewritten as a literal string. The on-disk
 * file is never modified.
 *
 * If the existing entry is a `{ path }` form, we leave it alone and
 * **prepend** the augmentation in a wrapper string — but since
 * `runAgent` reads the file lazily, the cleanest path is to resolve
 * the file ourselves. To keep this code path lightweight we instead
 * convert path-form prompts to literal form only after `runAgent`
 * has loaded them. See `applyTextModeAugmentation`'s callers.
 *
 * For the in-memory `AgentManifest` shape the CLI uses, the field is
 * already a string in nearly all cases (parsed by the TOML parser).
 * We handle both forms safely below.
 */
export function applyTextModeAugmentation(
  manifest: AgentManifest,
): AgentManifest {
  const existing = manifest.systemPrompt;
  if (existing === undefined) {
    return { ...manifest, systemPrompt: TEXT_MODE_PROMPT_AUGMENTATION };
  }
  if (typeof existing === "string") {
    const joined = existing.trimEnd()
      ? existing.trimEnd() + "\n\n" + TEXT_MODE_PROMPT_AUGMENTATION
      : TEXT_MODE_PROMPT_AUGMENTATION;
    return { ...manifest, systemPrompt: joined };
  }
  // `{ path }` form: leave the path alone, but tack the augmentation
  // onto the *resolved* prompt instead. Callers convert via
  // `augmentResolvedSystemPrompt` after the agent boots.
  return manifest;
}

// ──────────────────────────────────────────────────────────────────
// Renderers
// ──────────────────────────────────────────────────────────────────

export interface PromptRenderer {
  render(update: SessionUpdate): void;
  /** Called once after the update stream ends. */
  finish(): void;
}

export interface RendererStreams {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const defaultStreams = (): RendererStreams => ({
  stdout: process.stdout,
  stderr: process.stderr,
});

/**
 * Text renderer — buffers `agent_message_chunk` content; any
 * tool call (or update) clears the buffer (because the agent's
 * final answer comes *after* its last tool result). On `stop`,
 * the buffered text reaches stdout and any non-text blocks are
 * surfaced to stderr as `[image: ...]` placeholders.
 */
export class TextPromptRenderer implements PromptRenderer {
  private buffer: ContentBlock[] = [];
  private flushed = false;
  private readonly streams: RendererStreams;

  constructor(streams: RendererStreams = defaultStreams()) {
    this.streams = streams;
  }

  render(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.buffer.push(update.content);
        break;
      case "tool_call":
      case "tool_call_update":
        // A tool result invalidates any agent text that came before
        // it — the final answer is whatever follows the *last* tool
        // call, not what precedes it.
        this.buffer = [];
        break;
      case "stop":
        this.flush();
        break;
      // user_message_chunk, agent_thought_chunk, plan, usage_update,
      // available_commands_update, current_mode_update… all silent.
      default:
        break;
    }
  }

  finish(): void {
    if (!this.flushed) this.flush();
  }

  private flush(): void {
    this.flushed = true;
    const texts: string[] = [];
    const placeholders: string[] = [];
    for (const block of this.buffer) {
      if (block.type === "text") {
        texts.push(block.text);
      } else {
        placeholders.push(describeNonTextBlock(block));
      }
    }
    this.buffer = [];
    const text = texts.join("").trimEnd();
    if (text) {
      this.streams.stdout.write(text + "\n");
    }
    for (const p of placeholders) {
      this.streams.stderr.write(`[${p}]\n`);
    }
  }
}

/**
 * Trace renderer — labelled view, but **coalesced**. Agent and user
 * message chunks are buffered until a non-chunk boundary (tool call,
 * stop, etc.) or the stream ends, at which point they emit a single
 * `[agent] ...` / `[user] ...` line per logical message.
 *
 * Tool calls render the title + brief JSON input; their updates
 * render a status glyph + truncated output. The final stop reason
 * lands as `[stop] <reason>`, and any observed `usage_update` is
 * summarised to stderr after the turn.
 */
export class TracePromptRenderer implements PromptRenderer {
  private readonly streams: RendererStreams;
  private agentBuf: ContentBlock[] = [];
  private userBuf: ContentBlock[] = [];
  private thoughtBuf: ContentBlock[] = [];
  private lastUsage: { used: number; size: number } | null = null;

  constructor(streams: RendererStreams = defaultStreams()) {
    this.streams = streams;
  }

  render(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        this.userBuf.push(update.content);
        break;
      case "agent_message_chunk":
        this.flushUser();
        this.flushThought();
        this.agentBuf.push(update.content);
        break;
      case "agent_thought_chunk":
        this.flushUser();
        this.flushAgent();
        this.thoughtBuf.push(update.content);
        break;
      case "tool_call": {
        this.flushAll();
        const args = briefJson(update.rawInput);
        const line = args
          ? `[tool] ${update.title} ${args}`
          : `[tool] ${update.title}`;
        this.streams.stdout.write(line + "\n");
        break;
      }
      case "tool_call_update": {
        this.flushAll();
        const status = update.status ?? "in_progress";
        const glyph =
          status === "completed" ? "✓" : status === "failed" ? "✗" : "…";
        const text = collectToolText(update.content);
        this.streams.stdout.write(
          `[tool ${glyph}] ${truncate(text || "(no output)", 800)}\n`,
        );
        break;
      }
      case "plan":
        this.flushAll();
        for (const e of update.entries) {
          this.streams.stdout.write(`[plan] ${e.content}\n`);
        }
        break;
      case "usage_update":
        this.lastUsage = { used: update.used, size: update.size };
        break;
      case "stop":
        this.flushAll();
        this.streams.stdout.write(`[stop] ${update.stopReason}\n`);
        break;
      default:
        // Other SDK updates (available_commands_update,
        // current_mode_update, …) aren't useful in a one-shot trace.
        break;
    }
  }

  finish(): void {
    this.flushAll();
    if (this.lastUsage) {
      this.streams.stderr.write(
        `[usage] ${this.lastUsage.used} / ${this.lastUsage.size} tokens\n`,
      );
    }
  }

  private flushAll(): void {
    this.flushUser();
    this.flushAgent();
    this.flushThought();
  }

  private flushUser(): void {
    if (this.userBuf.length === 0) return;
    const text = renderInlineBlocks(this.userBuf);
    this.userBuf = [];
    if (text) this.streams.stdout.write(`[user] ${text}\n`);
  }

  private flushAgent(): void {
    if (this.agentBuf.length === 0) return;
    const text = renderInlineBlocks(this.agentBuf);
    this.agentBuf = [];
    if (text) this.streams.stdout.write(`[agent] ${text}\n`);
  }

  private flushThought(): void {
    if (this.thoughtBuf.length === 0) return;
    const text = renderInlineBlocks(this.thoughtBuf);
    this.thoughtBuf = [];
    if (text) this.streams.stdout.write(`[thought] ${text}\n`);
  }
}

/**
 * JSONL renderer — emit each `SessionUpdate` verbatim as a JSON
 * line. The consumer decides what to do with it. No special
 * handling, no augmentation, no exit-code surprises.
 */
export class JsonlPromptRenderer implements PromptRenderer {
  private readonly streams: RendererStreams;

  constructor(streams: RendererStreams = defaultStreams()) {
    this.streams = streams;
  }

  render(update: SessionUpdate): void {
    this.streams.stdout.write(JSON.stringify(update) + "\n");
  }

  finish(): void {
    // Nothing to flush.
  }
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function renderInlineBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.text);
    else parts.push(`[${describeNonTextBlock(b)}]`);
  }
  return parts.join("").trim();
}

function describeNonTextBlock(block: ContentBlock): string {
  switch (block.type) {
    case "image": {
      const size = approxBase64Size(block.data);
      const sz = size ? `, ${formatBytes(size)}` : "";
      return `image: ${block.mimeType ?? "unknown"}${sz}`;
    }
    case "audio": {
      const size = approxBase64Size(block.data);
      const sz = size ? `, ${formatBytes(size)}` : "";
      return `audio: ${block.mimeType ?? "unknown"}${sz}`;
    }
    case "resource_link":
      return `resource_link: ${block.uri}`;
    case "resource": {
      const r = block.resource;
      if ("uri" in r) return `resource: ${r.uri}`;
      return `resource`;
    }
    default:
      return (block as { type?: string }).type ?? "content";
  }
}

function approxBase64Size(data: string | undefined): number {
  if (!data) return 0;
  // Base64: 4 chars → 3 bytes. Approximate, ignoring padding.
  return Math.floor((data.length * 3) / 4);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function briefJson(v: unknown): string {
  if (v === undefined) return "";
  try {
    return truncate(JSON.stringify(v) ?? "", 200);
  } catch {
    return "";
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function collectToolText(
  content: ToolCallContent[] | null | undefined,
): string {
  if (!content) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (c.type === "content" && c.content.type === "text") {
      parts.push(c.content.text);
    }
  }
  return parts.join("").trim();
}

export function makeRenderer(
  format: PromptFormat,
  streams?: RendererStreams,
): PromptRenderer {
  switch (format) {
    case "text":
      return new TextPromptRenderer(streams);
    case "trace":
      return new TracePromptRenderer(streams);
    case "jsonl":
      return new JsonlPromptRenderer(streams);
  }
}

// ──────────────────────────────────────────────────────────────────
// Command entry point — used by `loom prompt` and by tests.
// ──────────────────────────────────────────────────────────────────

export interface RunPromptOptions {
  manifest: string | AgentManifest;
  text: string;
  format: PromptFormat;
  /**
   * When true, emits one `{"preamble": {...}}` JSON line on stdout
   * before the turn's events. Requires `format === "jsonl"` — the
   * CLI rejects the combination otherwise. Use this to capture a
   * full audit record for the turn (system prompt + history events
   * + tool list as the model will see them) in the same invocation
   * that drives the prompt.
   */
  emitPreamble?: boolean;
  permissionHandler?: PermissionHandler;
  onMissingSecret?: OnMissingSecret;
  onAuditFinding?: (
    finding: AuditFinding & { tool: string },
  ) => void | Promise<void>;
  streams?: RendererStreams;
  /** Hook for tests — observe the booted agent before the prompt runs. */
  onAgentReady?: (agent: RunningAgent) => void;
}

/**
 * Boot the agent, run one turn, render the stream according to
 * `format`, and return the resulting Unix exit code.
 *
 * Caller is responsible for parsing flags and reading stdin (this
 * function takes the resolved `text` as a string).
 */
export async function runPromptCommand(
  opts: RunPromptOptions,
): Promise<number> {
  const streams = opts.streams ?? defaultStreams();

  let manifest = opts.manifest;
  if (opts.format === "text") {
    // Augment in-memory only. The TOML file on disk is untouched.
    if (typeof manifest !== "string") {
      manifest = applyTextModeAugmentation(manifest);
    } else {
      // Path form: parse, augment, then hand the augmented manifest
      // to runAgent (which accepts either form).
      const { parseAgentManifest } = await import("../manifest/parser.js");
      const parsed = await parseAgentManifest(manifest);
      manifest = applyTextModeAugmentation(parsed);
    }
  }

  const agent = await runAgent(manifest, {
    ...(opts.permissionHandler
      ? { permissionHandler: opts.permissionHandler }
      : {}),
    ...(opts.onMissingSecret ? { onMissingSecret: opts.onMissingSecret } : {}),
    ...(opts.onAuditFinding ? { onAuditFinding: opts.onAuditFinding } : {}),
  });
  opts.onAgentReady?.(agent);

  const renderer = makeRenderer(opts.format, streams);
  const sub = agent.updates();
  const consume = (async () => {
    for await (const u of sub) renderer.render(u);
  })();

  let stopReason: StopReason = "end_turn";
  let runErr: unknown = null;
  try {
    const result = await agent.prompt(
      opts.text,
      opts.emitPreamble
        ? {
            onPreamble: (preamble) => {
              // Single JSON line, distinguishable from SessionUpdates
              // (which always carry a `sessionUpdate` field) by the
              // top-level `preamble` key. Always emit on stdout — the
              // CLI already constrained this to `--format jsonl`, so
              // it composes naturally with the rest of the stream.
              streams.stdout.write(JSON.stringify({ preamble }) + "\n");
            },
          }
        : undefined,
    );
    stopReason = result.stopReason;
  } catch (e) {
    runErr = e;
    stopReason = "error";
  } finally {
    await agent.close();
    await consume.catch(() => undefined);
    renderer.finish();
  }

  if (runErr) {
    const msg = (runErr as Error).message ?? String(runErr);
    streams.stderr.write(`loom prompt: ${msg}\n`);
  }
  return exitCodeForStopReason(stopReason);
}
