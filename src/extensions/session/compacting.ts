/**
 * CompactingSession — a Session wrapper that summarises older events
 * once the log grows past a threshold.
 *
 * Shape:
 *   const s = new CompactingSession({ threshold: 40, keep: 10 });
 *
 * Semantics:
 *   - Plain in-memory log for `append/getEvents/count`.
 *   - On every turn, loom calls `prepareTurn(ctx)`. If the log has
 *     reached the threshold, the session compacts: events `[0, cutoff)`
 *     are replaced with two synthetic events (a `user_message_chunk`
 *     introducing the summary and an `agent_message_chunk` carrying it).
 *     The most recent `keep` events stay verbatim.
 *
 * Compaction policy:
 *   Default is a deterministic heuristic — no model call. To use the
 *   model, pass `compactor: modelCompactor()`; the model-driven path
 *   uses the per-turn `Agent`'s harness via `summarise(harness, ...)`.
 *
 * Tool-call pairing:
 *   The harness's wire format pairs `tool_call` with a later
 *   `tool_call_update`. Compaction never cuts between a pair: the
 *   cutoff slides *backwards* past any tool_call that doesn't yet have
 *   its update inside the compaction range.
 *
 * No bound state:
 *   The compacting session does not store the `Agent` between calls.
 *   Loom hands it to `prepareTurn` each turn, which extracts the
 *   harness for the compactor. Tests and standalone use can call
 *   `compactNow()` with a harness directly (or `null` for
 *   heuristic-only behaviour).
 */

import type {
  Agent,
  ExtensionContext,
  Harness,
  Session,
  SessionFactory,
} from "../../types/interfaces.js";
import type { SessionUpdate } from "../../types/acp.js";
import { summarise } from "../../sdk/session-utils.js";

export interface Compactor {
  /**
   * Produce the replacement events for `oldEvents`. Implementations can
   * return any sequence of well-formed updates; loom will splice the
   * result in front of the kept tail.
   *
   * `harness` is the harness available for model-driven compaction (the
   * parent agent's harness when called via `prepareTurn`, or whatever
   * the caller passed to `compactNow`). May be null — compactors that
   * need a model fall back to a heuristic in that case.
   */
  (
    oldEvents: SessionUpdate[],
    harness: Harness | null,
  ): Promise<SessionUpdate[]> | SessionUpdate[];
}

export interface CompactingSessionOptions {
  /**
   * Compact when the in-memory log reaches this many events. Default 40.
   * Used as a fallback when no `usage_update` event has landed (e.g.
   * harnesses that don't track tokens, or first turn before a response).
   */
  threshold?: number;
  /**
   * Compact when the most recent `usage_update.used` value is at or
   * above this many tokens. Takes priority over `threshold` when usage
   * data is available. Optional — omit for event-count-only behaviour.
   */
  tokenThreshold?: number;
  /** Most recent `keep` events that survive verbatim. Default 10. */
  keep?: number;
  /** Replace the heuristic summarizer with a custom one. */
  compactor?: Compactor;
  /**
   * Diagnostic hook fired after each successful compaction. Receives the
   * pre-compaction count and the post-compaction count.
   */
  onCompact?: (info: { before: number; after: number }) => void;
}

export class CompactingSession implements Session {
  private events: SessionUpdate[] = [];
  private compacting = false;
  /**
   * The most recent `used` and `size` from a `usage_update` event. Held
   * in memory only — `usage_update` events are NOT appended to the
   * durable log. The data is metadata, not conversation history.
   */
  private lastUsed: number | null = null;
  private lastSize: number | null = null;
  private readonly threshold: number;
  private readonly tokenThreshold: number | null;
  private readonly keep: number;
  private readonly compactor: Compactor;
  private readonly onCompact?: (info: {
    before: number;
    after: number;
  }) => void;

  constructor(opts: CompactingSessionOptions = {}) {
    this.threshold = opts.threshold ?? 40;
    this.tokenThreshold = opts.tokenThreshold ?? null;
    this.keep = opts.keep ?? 10;
    this.compactor = opts.compactor ?? heuristicCompactor;
    if (opts.onCompact) this.onCompact = opts.onCompact;
    if (this.threshold <= this.keep + 2) {
      // Pathological config: there's no slice to compact. Bump threshold.
      this.threshold = this.keep + 4;
    }
  }

  async append(update: SessionUpdate): Promise<void> {
    if (update.sessionUpdate === "usage_update") {
      // Track in memory; don't pollute the durable log with metadata.
      this.lastUsed = update.used;
      this.lastSize = update.size;
      return;
    }
    this.events.push(update);
  }

  /** Most recent `used` value seen on a `usage_update`, or null. */
  get tokensInContext(): number | null {
    return this.lastUsed;
  }

  /** Most recent `size` value seen on a `usage_update`, or null. */
  get contextWindow(): number | null {
    return this.lastSize;
  }

  async getEvents(from = 0, to?: number): Promise<SessionUpdate[]> {
    return this.events.slice(from, to);
  }

  async count(): Promise<number> {
    return this.events.length;
  }

  /**
   * Per-turn hook. Loom calls this after the user message has been
   * appended and before the runtime is built. We compact here when
   * either the token-threshold is met (priority when we have usage
   * data) or the event-count threshold is met (fallback when usage
   * data isn't available yet).
   */
  async prepareTurn(agent: Agent): Promise<void> {
    if (this.shouldCompact()) {
      await this.runCompaction(agent.harness, false);
    }
  }

  private shouldCompact(): boolean {
    if (this.tokenThreshold !== null && this.lastUsed !== null) {
      // Token-aware path: trip when the last reading is at the bar.
      return this.lastUsed >= this.tokenThreshold;
    }
    return this.events.length >= this.threshold;
  }

  /**
   * Force a compaction pass regardless of the threshold. Useful for
   * tests and for sessions that want to expose a manual compaction
   * trigger. Pass a harness if the chosen compactor needs one (the
   * model compactor falls back to heuristic on null).
   */
  async compactNow(
    harness: Harness | null = null,
  ): Promise<{ before: number; after: number } | null> {
    return this.runCompaction(harness, true);
  }

  private async runCompaction(
    harness: Harness | null,
    force: boolean,
  ): Promise<{ before: number; after: number } | null> {
    if (this.compacting) return null;
    const before = this.events.length;
    let cutoff = before - this.keep;
    if (!force && cutoff < 2) return null;
    cutoff = adjustForToolPairs(this.events, cutoff);
    if (cutoff < 1) return null;

    this.compacting = true;
    try {
      const slice = this.events.slice(0, cutoff);
      const replacement = await Promise.resolve(this.compactor(slice, harness));
      this.events = [...replacement, ...this.events.slice(cutoff)];
    } finally {
      this.compacting = false;
    }
    const after = this.events.length;
    const info = { before, after };
    this.onCompact?.(info);
    return info;
  }
}

/**
 * Find the largest cutoff `≤ desired` such that no tool_call is
 * orphaned across the boundary (i.e. its update lives in the kept tail).
 *
 * We don't try to repair history; we just shrink the compaction window.
 * If no safe cutoff exists, returns 0.
 */
export function adjustForToolPairs(
  events: SessionUpdate[],
  desired: number,
): number {
  let cutoff = Math.max(0, Math.min(desired, events.length));
  // Collect tool_call ids that appear in [0, cutoff).
  while (cutoff > 0) {
    const callIds = new Set<string>();
    for (let i = 0; i < cutoff; i++) {
      const e = events[i];
      if (e && e.sessionUpdate === "tool_call") callIds.add(e.toolCallId);
    }
    // If every call has its update inside [0, cutoff) too, we're safe.
    let orphan = false;
    for (const id of callIds) {
      let resolved = false;
      for (let i = 0; i < cutoff; i++) {
        const e = events[i];
        if (
          e &&
          e.sessionUpdate === "tool_call_update" &&
          e.toolCallId === id
        ) {
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        orphan = true;
        break;
      }
    }
    if (!orphan) return cutoff;
    cutoff -= 1;
  }
  return 0;
}

/**
 * Default (model-free) compactor.
 *
 * Produces a synthetic user→agent pair: the user introduces the summary
 * (so the model sees it as conversation), the agent acknowledges with a
 * one-line-per-event recap.
 */
export const heuristicCompactor: Compactor = (events, _harness = null) => {
  const lines: string[] = [];
  for (const e of events) {
    const line = summarizeOne(e);
    if (line) lines.push(line);
  }
  const summary =
    lines.length === 0 ? "(no significant prior events)" : lines.join("\n");
  return [
    {
      sessionUpdate: "user_message_chunk",
      content: {
        type: "text",
        text:
          "Here is a summary of the earlier conversation. Treat it as " +
          "background context; respond to the most recent message.",
      },
    },
    {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `[summary of ${events.length} earlier events]\n${summary}`,
      },
    },
  ];
};

function summarizeOne(e: SessionUpdate): string {
  switch (e.sessionUpdate) {
    case "user_message_chunk":
      return `user: ${truncate(textOf(e.content), 120)}`;
    case "agent_message_chunk":
      return `agent: ${truncate(textOf(e.content), 120)}`;
    case "agent_thought_chunk":
      return ""; // thoughts aren't relevant to context
    case "tool_call": {
      const inp = previewJson(e.input);
      return `tool ${e.title}(${inp})`;
    }
    case "tool_call_update": {
      const text = (e.content ?? [])
        .map((c) =>
          c.type === "content" && c.content.type === "text"
            ? c.content.text
            : "",
        )
        .join("");
      return `  → ${e.status ?? "?"}: ${truncate(text, 120)}`;
    }
    case "plan":
    case "stop":
    case "usage_update":
      return "";
  }
}

function textOf(c: { type: string; text?: string }): string {
  return c.type === "text" && typeof c.text === "string" ? c.text : "";
}

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max - 1) + "…" : collapsed;
}

// ─────────────────────────────────────────────────────────────────────────
// Model-driven compactor.
// ─────────────────────────────────────────────────────────────────────────

export interface ModelCompactorOptions {
  /**
   * Instruction the summariser sees alongside the conversation. The
   * default asks for a tight prose summary that preserves task
   * progress, decisions, and any open threads. Override when you need
   * domain-specific phrasing.
   */
  instruction?: string;
  /**
   * Optional system prompt for the summarisation turn. Default is
   * empty — we want a neutral summary, not one staying in the parent
   * agent's persona. Override when you need domain-specific framing.
   */
  systemPrompt?: string;
  /**
   * If no harness is available (compaction triggered standalone with
   * `compactNow()` and no harness arg), fall back to this compactor
   * instead of failing. Defaults to `heuristicCompactor`.
   */
  fallback?: Compactor;
}

const DEFAULT_MODEL_INSTRUCTION =
  "You are summarising the conversation above so it can be replaced with a " +
  "compact background note. Produce one tight paragraph (≤ 200 words) that " +
  "preserves: the user's goals, decisions made, file paths and identifiers " +
  "that came up, and any unfinished work. Plain prose. No headings.";

/**
 * Build a Compactor that drives the supplied harness to summarise the
 * slice (via `summarise(harness, ...)` — native if the harness
 * implements it, fallback via `summariseViaRun` otherwise) and splices
 * the result into the log as a synthetic user→agent pair.
 *
 * If no harness is supplied (the compactor was called with `null`),
 * falls back to a heuristic compactor.
 */
export function modelCompactor(opts: ModelCompactorOptions = {}): Compactor {
  const instruction = opts.instruction ?? DEFAULT_MODEL_INSTRUCTION;
  const systemPrompt = opts.systemPrompt ?? "";
  const fallback = opts.fallback ?? heuristicCompactor;
  return async (events, harness) => {
    if (!harness) return fallback(events, harness);
    const summary = (
      await summarise(harness, { events, instruction, systemPrompt })
    ).trim();
    if (!summary) return fallback(events, harness);
    return [
      {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "text",
          text:
            "Here is a summary of the earlier conversation. Treat it as " +
            "background context; respond to the most recent message.",
        },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `[summary of ${events.length} earlier events]\n${summary}`,
        },
      },
    ];
  };
}

function previewJson(v: unknown): string {
  if (v === undefined) return "";
  try {
    const s = JSON.stringify(v);
    if (!s) return "";
    return s.length > 60 ? s.slice(0, 57) + "..." : s;
  } catch {
    return "";
  }
}

/**
 * Factory shape. Config (all optional):
 *   threshold:      number
 *   keep:           number
 *
 * The factory cannot supply a custom `compactor` (it's code, not config);
 * SDK consumers wanting a custom compactor should construct
 * `CompactingSession` directly and pass the instance as `session`.
 */
export const compactingSessionFactory: SessionFactory = {
  name: "compacting",
  create(
    config: Record<string, unknown>,
    _ctx: ExtensionContext,
    _secrets: Record<string, string>,
  ): Session {
    const opts: CompactingSessionOptions = {};
    if (typeof config.threshold === "number") opts.threshold = config.threshold;
    if (typeof config.keep === "number") opts.keep = config.keep;
    return new CompactingSession(opts);
  },
};
