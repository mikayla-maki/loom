/**
 * CompactingSession — a Session wrapper that summarises older events
 * once the log grows past a threshold.
 *
 * Shape:
 *   const s = new CompactingSession({ threshold: 40, keep: 10 });
 *
 * Semantics:
 *   - Wraps an in-memory log (the normal Session API: append/getEvents/count).
 *   - When `count >= threshold`, the next `append` triggers compaction:
 *     events `[0, cutoff)` are replaced with two synthetic events
 *     (a `user_message_chunk` introducing the summary and an
 *     `agent_message_chunk` carrying it). The most recent `keep` events
 *     stay verbatim.
 *
 * Compaction policy:
 *   The default is a deterministic heuristic — no model call. It
 *   produces a one-line-per-event summary, which is enough to keep the
 *   conversation coherent for short sessions and surfaces the rough
 *   edges around model-driven compaction. To plug in a real summarising
 *   compactor (one that drives a model turn), pass a `compactor`
 *   function: it receives the slice to compress and returns the
 *   replacement events.
 *
 * Tool-call pairing:
 *   The harness's wire format pairs `tool_call` with a later
 *   `tool_call_update`. Compaction never cuts between a pair: the
 *   cutoff slides *backwards* past any tool_call that doesn't yet have
 *   its update inside the compaction range.
 */

import type {
  ExtensionContext,
  Session,
  SessionFactory,
} from "../../types/interfaces.js";
import type { SessionUpdate } from "../../types/acp.js";

export interface Compactor {
  /**
   * Produce the replacement events for `oldEvents`. Implementations can
   * return any sequence of well-formed updates; loom will splice the
   * result in front of the kept tail.
   */
  (oldEvents: SessionUpdate[]): Promise<SessionUpdate[]> | SessionUpdate[];
}

export interface CompactingSessionOptions {
  /** Compact when the in-memory log reaches this many events. Default 40. */
  threshold?: number;
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
  private readonly threshold: number;
  private readonly keep: number;
  private readonly compactor: Compactor;
  private readonly onCompact?: (info: {
    before: number;
    after: number;
  }) => void;

  constructor(opts: CompactingSessionOptions = {}) {
    this.threshold = opts.threshold ?? 40;
    this.keep = opts.keep ?? 10;
    this.compactor = opts.compactor ?? heuristicCompactor;
    if (opts.onCompact) this.onCompact = opts.onCompact;
    if (this.threshold <= this.keep + 2) {
      // Pathological config: there's no slice to compact. Bump threshold.
      this.threshold = this.keep + 4;
    }
  }

  async append(update: SessionUpdate): Promise<void> {
    this.events.push(update);
    await this.maybeCompact();
  }

  async getEvents(from = 0, to?: number): Promise<SessionUpdate[]> {
    return this.events.slice(from, to);
  }

  async count(): Promise<number> {
    return this.events.length;
  }

  /**
   * Force a compaction pass even if the threshold isn't met. Useful for
   * tests and for harness-driven compaction policies.
   */
  async compactNow(): Promise<{ before: number; after: number } | null> {
    return this.runCompaction(true);
  }

  private async maybeCompact(): Promise<void> {
    if (this.events.length < this.threshold) return;
    await this.runCompaction(false);
  }

  private async runCompaction(
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
      const replacement = await Promise.resolve(this.compactor(slice));
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
export const heuristicCompactor: Compactor = (events) => {
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
