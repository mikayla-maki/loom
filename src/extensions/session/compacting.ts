/**
 * CompactingSession — a wrapping session that summarises older events
 * once the log grows past a threshold.
 *
 * Wrapping pattern: holds an `inner` Session as a private dependency
 * and decides on its own schedule when to materialise a summary. On
 * `pull`, returns the summary cache (if present) prepended to recent
 * events from the inner session. On `push`, forwards to the inner and
 * may trigger a compaction asynchronously.
 *
 * Dynamic pull is the reason for wrapping rather than chaining: a
 * pure pull-side transform would have to recompute the summary on
 * every read (since reads can happen many times per turn). The
 * wrapper caches the summary and updates it on its own schedule.
 *
 * Compaction policy:
 *   Default is a deterministic heuristic — no model call. To use the
 *   model, pass `compactor: modelCompactor()`; the model-driven path
 *   uses the per-turn `Agent`'s harness via `summarise(harness, ...)`.
 *
 * Tool-call pairing:
 *   The harness's wire format pairs `tool_call` with a later
 *   `tool_call_update`. Compaction never cuts between a pair: the
 *   cutoff slides *backwards* past any tool_call that doesn't yet
 *   have its update inside the compaction range.
 */

import type {
  Agent,
  ExtensionContext,
  Harness,
  Session,
  SessionFactory,
  ToolRef,
} from "../../types/interfaces.js";
import type { SessionUpdate } from "../../types/acp.js";
import { summarise } from "../../sdk/session-utils.js";
import { MemorySession } from "./memory.js";
import { FileSession } from "./file.js";

export interface Compactor {
  /**
   * Produce the replacement events for `oldEvents`. Implementations
   * can return any sequence of well-formed updates; the compacting
   * session splices the result in front of the kept tail.
   *
   * `harness` is the harness available for model-driven compaction
   * (the parent agent's harness when called via `prepareTurn`, or
   * whatever the caller passed to `compactNow`). May be null —
   * compactors that need a model fall back to a heuristic.
   */
  (
    oldEvents: SessionUpdate[],
    harness: Harness | null,
  ): Promise<SessionUpdate[]> | SessionUpdate[];
}

export interface CompactingSessionOptions {
  /**
   * Compact when the inner log reaches this many events. Default 40.
   * Used as a fallback when no `usage_update` event has landed.
   */
  threshold?: number;
  /**
   * Compact when the most recent `usage_update.used` value is at or
   * above this many tokens. Takes priority over `threshold` when
   * usage data is available.
   */
  tokenThreshold?: number;
  /** Most recent `keep` events that survive verbatim. Default 10. */
  keep?: number;
  /** Replace the heuristic summarizer with a custom one. */
  compactor?: Compactor;
  /**
   * Diagnostic hook fired after each successful compaction.
   * Receives the pre-compaction count and the post-compaction count.
   */
  onCompact?: (info: { before: number; after: number }) => void;
}

/**
 * Wraps an inner session and summarises older events past a threshold.
 *
 * Construction takes the inner session explicitly, so the wrapping
 * relationship is honest — `new CompactingSession(new FileSession(...))`
 * vs `new CompactingSession(new MemorySession())` for different
 * storage backends.
 */
export class CompactingSession implements Session {
  /** Cached summary events covering events `[0, summarizedThrough)`. */
  private cachedSummary: SessionUpdate[] | null = null;
  private summarizedThrough = 0;
  private compacting = false;
  /** Most recent `used`/`size` from a `usage_update` event. */
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

  constructor(
    private readonly inner: Session,
    opts: CompactingSessionOptions = {},
  ) {
    this.threshold = opts.threshold ?? 40;
    this.tokenThreshold = opts.tokenThreshold ?? null;
    this.keep = opts.keep ?? 10;
    this.compactor = opts.compactor ?? heuristicCompactor;
    if (opts.onCompact) this.onCompact = opts.onCompact;
    if (this.threshold <= this.keep + 2) {
      // Pathological config: there's no slice to compact.
      this.threshold = this.keep + 4;
    }
  }

  async push(update: SessionUpdate): Promise<SessionUpdate[]> {
    if (update.sessionUpdate === "usage_update") {
      // Track in memory; don't pollute the inner log with metadata.
      this.lastUsed = update.used;
      this.lastSize = update.size;
      return [];
    }
    return await (this.inner.push?.(update) ?? [update]);
  }

  async pull(_below: SessionUpdate[]): Promise<SessionUpdate[]> {
    // Wrapping: ignore `_below` and pull from inner directly. The
    // outer caller passed `[]` (we're a top-level session); inside a
    // ChainedSession the chain semantics still work because we
    // produce our own view from inner.
    const innerEvents = await (this.inner.pull?.([]) ?? []);
    if (this.cachedSummary && this.summarizedThrough > 0) {
      // Splice the summary in front of the events not yet covered.
      const recent = innerEvents.slice(this.summarizedThrough);
      return [...this.cachedSummary, ...recent];
    }
    return innerEvents;
  }

  /** Most recent `used` value seen on a `usage_update`, or null. */
  get tokensInContext(): number | null {
    return this.lastUsed;
  }

  /** Most recent `size` value seen on a `usage_update`, or null. */
  get contextWindow(): number | null {
    return this.lastSize;
  }

  /**
   * Per-turn hook. Loom calls this after the user message has been
   * pushed and before the runtime is built. Compacts when either the
   * token-threshold (priority) or event-count threshold is met.
   */
  async prepareTurn(agent: Agent): Promise<void> {
    if (await this.shouldCompact()) {
      await this.runCompaction(agent.harness, false);
    }
  }

  private async shouldCompact(): Promise<boolean> {
    if (this.tokenThreshold !== null && this.lastUsed !== null) {
      // Token-aware path: trip when the last reading is at the bar.
      return this.lastUsed >= this.tokenThreshold;
    }
    const innerEvents = await (this.inner.pull?.([]) ?? []);
    return innerEvents.length >= this.threshold;
  }

  /**
   * Force a compaction pass regardless of the threshold. Useful for
   * tests and manual triggers. Pass a harness if the chosen compactor
   * needs one (the model compactor falls back to heuristic on null).
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
    const innerEvents = await (this.inner.pull?.([]) ?? []);
    const before = innerEvents.length;
    let cutoff = before - this.keep;
    if (!force && cutoff < 2) return null;
    cutoff = adjustForToolPairs(innerEvents, cutoff);
    if (cutoff < 1) return null;

    this.compacting = true;
    try {
      const slice = innerEvents.slice(0, cutoff);
      const replacement = await Promise.resolve(this.compactor(slice, harness));
      this.cachedSummary = replacement;
      this.summarizedThrough = cutoff;
    } finally {
      this.compacting = false;
    }
    // For diagnostic purposes: report the post-compaction event count
    // as visible to a downstream consumer (summary + recent).
    const after = (this.cachedSummary?.length ?? 0) + (before - cutoff);
    const info = { before, after };
    this.onCompact?.(info);
    return info;
  }
}

/**
 * Find the largest cutoff `≤ desired` such that no tool_call is
 * orphaned across the boundary (i.e. its update lives in the kept
 * tail).
 */
export function adjustForToolPairs(
  events: SessionUpdate[],
  desired: number,
): number {
  let cutoff = Math.max(0, Math.min(desired, events.length));
  while (cutoff > 0) {
    const callIds = new Set<string>();
    for (let i = 0; i < cutoff; i++) {
      const e = events[i];
      if (e && e.sessionUpdate === "tool_call") callIds.add(e.toolCallId);
    }
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
 * Produces a synthetic user→agent pair: the user introduces the
 * summary (so the model sees it as conversation), the agent
 * acknowledges with a one-line-per-event recap.
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
      return "";
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
  instruction?: string;
  systemPrompt?: string;
  fallback?: Compactor;
}

const DEFAULT_MODEL_INSTRUCTION =
  "You are summarising the conversation above so it can be replaced with a " +
  "compact background note. Produce one tight paragraph (≤ 200 words) that " +
  "preserves: the user's goals, decisions made, file paths and identifiers " +
  "that came up, and any unfinished work. Plain prose. No headings.";

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

// ─────────────────────────────────────────────────────────────────────────
// Convenience builders.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Convenience: a compacting session backed by an in-memory log.
 * Equivalent to `new CompactingSession(new MemorySession(), opts)`.
 */
export function compactingMemorySession(
  opts: CompactingSessionOptions = {},
): CompactingSession {
  return new CompactingSession(new MemorySession(), opts);
}

/**
 * Convenience: a compacting session backed by a file log.
 */
export function compactingFileSession(
  filePath: string,
  opts: CompactingSessionOptions = {},
): CompactingSession {
  return new CompactingSession(new FileSession(filePath), opts);
}

// ─────────────────────────────────────────────────────────────────────────
// ChainedSession — the chain composition primitive.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Composes N sessions as a pipeline.
 *
 * - `push`: events flow top-to-bottom. Each child may transform,
 *   drop, or fan-out via its return value. The result is what fell
 *   out of the bottom (Loom ignores it for the outer call).
 * - `pull`: events flow bottom-to-top. Each child receives upstream
 *   events from below and may augment/transform.
 * - `prepareTurn`, `systemPromptSection`, `tools`, `dependencies`,
 *   `close`: contributions from all children are aggregated.
 */
export class ChainedSession implements Session {
  constructor(private readonly children: readonly Session[]) {}

  async push(event: SessionUpdate): Promise<SessionUpdate[]> {
    let events: SessionUpdate[] = [event];
    for (const child of this.children) {
      const out: SessionUpdate[] = [];
      for (const e of events) {
        const forwarded = (await child.push?.(e)) ?? [e];
        out.push(...forwarded);
      }
      events = out;
      if (events.length === 0) break;
    }
    return events;
  }

  async pull(below: SessionUpdate[]): Promise<SessionUpdate[]> {
    let events = below;
    for (const child of [...this.children].reverse()) {
      events = (await child.pull?.(events)) ?? events;
    }
    return events;
  }

  async prepareTurn(agent: Agent): Promise<void> {
    for (const c of this.children) await c.prepareTurn?.(agent);
  }

  async systemPromptSection(agent: Agent): Promise<string> {
    const parts: string[] = [];
    for (const c of this.children) {
      const part = await c.systemPromptSection?.(agent);
      if (part) parts.push(part);
    }
    return parts.join("\n\n");
  }

  async tools(): Promise<ToolRef[]> {
    const all: ToolRef[] = [];
    for (const c of this.children) {
      const ts = (await c.tools?.()) ?? [];
      all.push(...ts);
    }
    return all;
  }

  get dependencies(): {
    subagents?: import("../../types/manifest.js").AgentManifest[];
  } {
    const subagents: import("../../types/manifest.js").AgentManifest[] = [];
    for (const c of this.children) {
      subagents.push(...(c.dependencies?.subagents ?? []));
    }
    return subagents.length > 0 ? { subagents } : {};
  }

  async close(): Promise<void> {
    for (const c of this.children) await c.close?.();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Factories.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Factory shape. Config (all optional):
 *   threshold:      number
 *   keep:           number
 *
 * Wraps an in-memory inner session by default. SDK consumers wanting
 * a different backing store (e.g. file log) should construct
 * `CompactingSession` directly.
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
    return new CompactingSession(new MemorySession(), opts);
  },
};
