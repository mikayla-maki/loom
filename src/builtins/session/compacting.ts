/**
 * CompactingSession — wraps an inner Session and summarises older events
 * past a threshold. Wraps rather than chains because the summary is
 * cached and updated on its own schedule (a pull-side transform would
 * recompute on every read).
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
  ToolRef,
  TrustedPath,
} from "../../types/interfaces.js";
import type { SessionUpdate } from "../../types/acp.js";
import type { AgentManifest } from "../../types/manifest.js";
import { summarise } from "../../sdk/session-utils.js";
import { MemorySession } from "./memory.js";
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

/** Wraps an inner session and summarises older events past a threshold. */
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
      // Pathological config: no slice would be left to compact.
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
    // Wrapping: ignore `_below` and pull from inner directly.
    const innerEvents = await (this.inner.pull?.([]) ?? []);
    if (this.cachedSummary && this.summarizedThrough > 0) {
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

  /** Per-turn hook. Compacts if token- or event-threshold is met. */
  async prepareTurn(agent: Agent): Promise<void> {
    if (await this.shouldCompact()) {
      await this.runCompaction(agent.harness, false);
    }
  }

  private async shouldCompact(): Promise<boolean> {
    if (this.tokenThreshold !== null && this.lastUsed !== null) {
      return this.lastUsed >= this.tokenThreshold;
    }
    const innerEvents = await (this.inner.pull?.([]) ?? []);
    return innerEvents.length >= this.threshold;
  }

  /** Force a compaction pass regardless of the threshold. */
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

// ─── Convenience builders ────────────────────────────────────────────────

/** Compacting session backed by an in-memory log. */
export function compactingMemorySession(
  opts: CompactingSessionOptions = {},
): CompactingSession {
  return new CompactingSession(new MemorySession(), opts);
}

/** Compacting session backed by a file log. */
export function compactingFileSession(
  filePath: string,
  opts: CompactingSessionOptions = {},
): CompactingSession {
  return new CompactingSession(new FileSession(filePath), opts);
}

// ─── ChainedSession — chain composition primitive ────────────────────────

/**
 * Composes N sessions as a pipeline. `push` flows top-to-bottom (each
 * child may transform/drop/fan-out); `pull` flows bottom-to-top.
 * Other hooks (prepareTurn, systemPromptSection, tools, trustedPaths,
 * dependencies, close) are aggregated across children.
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

  async trustedPaths(): Promise<TrustedPath[]> {
    // Concat without dedup; the audit/consuming layer merges duplicates.
    const all: TrustedPath[] = [];
    for (const c of this.children) {
      const ps = (await c.trustedPaths?.()) ?? [];
      all.push(...ps);
    }
    return all;
  }

  get dependencies(): { subagents?: AgentManifest[] } {
    const subagents: AgentManifest[] = [];
    for (const c of this.children) {
      subagents.push(...(c.dependencies?.subagents ?? []));
    }
    return subagents.length > 0 ? { subagents } : {};
  }

  async close(): Promise<void> {
    for (const c of this.children) await c.close?.();
  }
}

// ─── Factories ───────────────────────────────────────────────────────────

/**
 * Config (all optional): `threshold`, `keep`. Wraps `MemorySession` by
 * default; SDK consumers needing other backends should construct
 * `CompactingSession` directly.
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
    return new CompactingSession(new MemorySession(), opts);
  },
};
