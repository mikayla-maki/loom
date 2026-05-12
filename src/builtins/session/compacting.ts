/**
 * CompactingSession — a pull-side session transform that summarises
 * older events past a threshold. Sits above a storage layer in a
 * `ChainedSession`; the storage layer keeps the raw event log
 * unchanged, while this layer presents a compacted view to the layers
 * above it.
 *
 * On `push`, this layer is a passthrough — it lets every non-metadata
 * event flow downward to be stored. It *does* swallow `usage_update`
 * events so token usage stays in-memory metadata and never pollutes
 * the durable log.
 *
 * On `pull(below)`, it returns either `below` verbatim (no cached
 * summary) or `[...cachedSummary, ...below.slice(summarizedThrough)]`
 * (cache active). The cache is built when the event-count or token
 * thresholds trip, either inside `prepareTurn` or via `compactNow()`.
 *
 * Default compactor is a deterministic heuristic. Use `modelCompactor()`
 * for model-driven summarisation. Compaction never splits a tool_call
 * from its later tool_call_update: the cutoff slides back past any
 * orphan pair.
 */

import type {
  Agent,
  FactoryContext,
  Harness,
  Session,
  SessionFactory,
} from "../../types/interfaces.js";
import type { SessionUpdate } from "../../types/acp.js";
import { summarise } from "../../sdk/session-utils.js";
import { ChainedSession } from "../../runtime/session-chain.js";
import { InMemorySession } from "./memory.js";
import { FileSession } from "./file.js";

export interface Compactor {
  /**
   * Produce replacement events for `oldEvents`, spliced before the
   * kept tail. `harness` may be null; model-driven compactors fall
   * back to a heuristic in that case.
   */
  (
    oldEvents: SessionUpdate[],
    harness: Harness | null,
  ): Promise<SessionUpdate[]> | SessionUpdate[];
}

export interface CompactingSessionOptions {
  /** Event-count threshold. Default 40. Fallback when no usage data. */
  threshold?: number;
  /**
   * Token threshold (most recent `usage_update.used`). Takes priority
   * over `threshold` when usage data is available.
   */
  tokenThreshold?: number;
  /** Most recent `keep` events that survive verbatim. Default 10. */
  keep?: number;
  /** Replace the heuristic summarizer with a custom one. */
  compactor?: Compactor;
  /** Diagnostic hook fired after each successful compaction. */
  onCompact?: (info: { before: number; after: number }) => void;
}

/**
 * A pull-side transform that summarises older events past a threshold.
 * Designed to live in a `ChainedSession` above a storage layer (e.g.
 * `InMemorySession` or `FileSession`).
 */
export class CompactingSession implements Session {
  /** Cached summary events covering events `[0, summarizedThrough)`. */
  private cachedSummary: SessionUpdate[] | null = null;
  private summarizedThrough = 0;
  private compacting = false;
  /** Most recent `used`/`size` from a `usage_update` event. */
  private lastUsed: number | null = null;
  private lastSize: number | null = null;
  /**
   * Snapshot of `below` from the most recent `pull(below)` call.
   * Used by `prepareTurn` and `compactNow` to inspect what the chain
   * below us currently holds. Stays empty until the first pull —
   * which is fine, because the runtime calls `pull` before every
   * turn when assembling the prompt.
   */
  private latestBelow: SessionUpdate[] = [];
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
      // Pathological config: no slice would be left to compact.
      this.threshold = this.keep + 4;
    }
  }

  async push(update: SessionUpdate): Promise<SessionUpdate[]> {
    if (update.sessionUpdate === "usage_update") {
      // Track in memory; don't pollute the storage layer with metadata.
      this.lastUsed = update.used;
      this.lastSize = update.size;
      return [];
    }
    // Pass everything else through unchanged. The layer(s) below us
    // own storage.
    return [update];
  }

  async pull(below: SessionUpdate[]): Promise<SessionUpdate[]> {
    // Snapshot a fresh array so later layers can't mutate our view.
    this.latestBelow = below.slice();
    if (this.cachedSummary && this.summarizedThrough > 0) {
      const recent = below.slice(this.summarizedThrough);
      return [...this.cachedSummary, ...recent];
    }
    return below;
  }

  /** Most recent `used` value seen on a `usage_update`, or null. */
  get tokensInContext(): number | null {
    return this.lastUsed;
  }

  /** Most recent `size` value seen on a `usage_update`, or null. */
  get contextWindow(): number | null {
    return this.lastSize;
  }

  /** Per-turn hook. Compacts if token- or event-threshold is met. */
  async prepareTurn(agent: Agent): Promise<void> {
    // Refresh our view of events below us before checking thresholds.
    // ChainedSession.pull cascades down to the storage layer and back
    // up through us, populating `latestBelow` along the way. Doing
    // this here — instead of relying on whoever last pulled — keeps
    // the per-turn compaction decision based on the current event
    // count, matching the pre-chain behaviour where `inner.pull([])`
    // was always live.
    if (agent.session?.pull) {
      try {
        await agent.session.pull([]);
      } catch {
        // If the chain isn't accessible, fall back to the cached
        // `latestBelow` snapshot (token-threshold checks still work
        // regardless).
      }
    }
    if (this.shouldCompact()) {
      await this.runCompaction(agent.harness, false);
    }
  }

  private shouldCompact(): boolean {
    if (this.tokenThreshold !== null && this.lastUsed !== null) {
      return this.lastUsed >= this.tokenThreshold;
    }
    return this.latestBelow.length >= this.threshold;
  }

  /**
   * Force a compaction pass regardless of the threshold. Uses the
   * event snapshot from the most recent `pull(below)` call. If no
   * pull has happened yet, returns null (no events to compact).
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
    const events = this.latestBelow;
    const before = events.length;
    let cutoff = before - this.keep;
    if (!force && cutoff < 2) return null;
    cutoff = adjustForToolPairs(events, cutoff);
    if (cutoff < 1) return null;

    this.compacting = true;
    try {
      const slice = events.slice(0, cutoff);
      const replacement = await Promise.resolve(this.compactor(slice, harness));
      this.cachedSummary = replacement;
      this.summarizedThrough = cutoff;
    } finally {
      this.compacting = false;
    }
    // Report the visible count downstream (summary + recent).
    const after = (this.cachedSummary?.length ?? 0) + (before - cutoff);
    const info = { before, after };
    this.onCompact?.(info);
    return info;
  }
}

/**
 * Largest cutoff ≤ desired such that no tool_call in the compacted
 * slice is missing its tool_call_update inside the same slice.
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
 * Default (model-free) compactor. Emits a synthetic user→agent pair
 * with a one-line-per-event recap.
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
      const inp = previewJson(e.rawInput);
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
    default:
      // `plan`, `stop`, `usage_update`, and the SDK's newer
      // variants (`available_commands_update`, etc.) collapse to
      // empty summaries — they aren't model-visible turn content.
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

// ─── Model-driven compactor ──────────────────────────────────────────────

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

// ─── Convenience builders ───────────────────────────────────────

/**
 * Sugar for the common "compacting on top of in-memory storage" chain.
 * Returns a composed `Session` ready to pass to `runAgent`.
 *
 * SDK consumers who want access to the `CompactingSession` instance
 * (e.g. to wire `compactNow()` to a `/compact` slash command) should
 * construct the chain explicitly instead:
 *
 * ```ts
 * const compactor = new CompactingSession(opts);
 * const storage = new InMemorySession();
 * const session = new ChainedSession([compactor, storage]);
 * ```
 */
export function compactingMemorySession(
  opts: CompactingSessionOptions = {},
): Session {
  return new ChainedSession([
    new CompactingSession(opts),
    new InMemorySession(),
  ]);
}

/** Compacting session backed by a file log. See {@link compactingMemorySession}. */
export function compactingFileSession(
  filePath: string,
  opts: CompactingSessionOptions = {},
): Session {
  return new ChainedSession([
    new CompactingSession(opts),
    new FileSession(filePath),
  ]);
}

// ─── Factories ───────────────────────────────────────────────────────────

/**
 * Config (all optional): `threshold`, `keep`. Builds a pull-side
 * compacting transform. In v5 manifests this is meant to be a layer
 * in a `[session].layers` composition; the layer(s) below it own
 * storage. For example:
 *
 * ```toml
 * [session]
 * layers = ["compacting", "memory"]
 * ```
 *
 * Using `compacting` alone (singleton `[session]`) yields a no-op
 * transform with no storage layer below — events pass through and
 * are not retained.
 */
export const compactingSessionFactory: SessionFactory = {
  name: "compacting",
  create(
    config: Record<string, unknown>,
    _ctx: FactoryContext,
    _secrets: Record<string, string>,
  ): Session {
    const opts: CompactingSessionOptions = {};
    if (typeof config.threshold === "number") opts.threshold = config.threshold;
    if (typeof config.keep === "number") opts.keep = config.keep;
    return new CompactingSession(opts);
  },
};
