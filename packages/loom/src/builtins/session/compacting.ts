import * as fs from "node:fs/promises";
import * as path from "node:path";

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
  (
    oldEvents: SessionUpdate[],
    harness: Harness | null,
  ): Promise<SessionUpdate[]> | SessionUpdate[];
}

export interface CompactingSessionOptions {
  threshold?: number;
  tokenThreshold?: number;
  tokenFraction?: number;
  keep?: number;
  compactor?: Compactor;
  onCompact?: (info: { before: number; after: number }) => void;
  persistDir?: string;
}

export class CompactingSession implements Session {
  private cachedSummary: SessionUpdate[] | null = null;
  private summarizedThrough = 0;
  private compacting = false;
  private lastUsed: number | null = null;
  private lastSize: number | null = null;
  private latestBelow: SessionUpdate[] = [];
  private readonly threshold: number;
  private readonly tokenThreshold: number | null;
  private readonly tokenFraction: number | null;
  private readonly keep: number;
  private readonly compactor: Compactor;
  private readonly onCompact?: (info: {
    before: number;
    after: number;
  }) => void;
  private readonly persistDir: string | null;
  private stateLoaded = false;

  constructor(opts: CompactingSessionOptions = {}) {
    this.threshold = opts.threshold ?? 40;
    this.tokenThreshold = opts.tokenThreshold ?? null;
    this.tokenFraction = opts.tokenFraction ?? null;
    this.keep = opts.keep ?? 10;
    this.compactor = opts.compactor ?? heuristicCompactor;
    if (opts.onCompact) this.onCompact = opts.onCompact;
    this.persistDir = opts.persistDir ?? null;
    if (this.threshold <= this.keep + 2) {
      this.threshold = this.keep + 4;
    }
  }

  private async maybeLoadState(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    if (!this.persistDir) return;
    const statePath = path.join(this.persistDir, "state.json");
    try {
      const raw = await fs.readFile(statePath, "utf8");
      const parsed = JSON.parse(raw) as {
        version?: number;
        summarizedThrough?: number;
        cachedSummary?: SessionUpdate[];
        lastUsed?: number | null;
        lastSize?: number | null;
      };
      if (parsed.version === 1) {
        if (
          typeof parsed.summarizedThrough === "number" &&
          Array.isArray(parsed.cachedSummary)
        ) {
          this.summarizedThrough = parsed.summarizedThrough;
          this.cachedSummary = parsed.cachedSummary;
        }
        if (typeof parsed.lastUsed === "number") {
          this.lastUsed = parsed.lastUsed;
        }
        if (typeof parsed.lastSize === "number") {
          this.lastSize = parsed.lastSize;
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        // eslint-disable-next-line no-console
        console.warn(
          `CompactingSession: failed to load state from ${statePath}: ${
            (e as Error).message
          }`,
        );
      }
    }
  }

  private async saveState(): Promise<void> {
    if (!this.persistDir) return;
    await fs.mkdir(this.persistDir, { recursive: true });
    const statePath = path.join(this.persistDir, "state.json");
    const tmpPath = `${statePath}.tmp`;
    const payload = JSON.stringify({
      version: 1,
      summarizedThrough: this.summarizedThrough,
      cachedSummary: this.cachedSummary,
      lastUsed: this.lastUsed,
      lastSize: this.lastSize,
    });
    await fs.writeFile(tmpPath, payload, "utf8");
    await fs.rename(tmpPath, statePath);
  }

  async push(update: SessionUpdate): Promise<SessionUpdate[]> {
    if (update.sessionUpdate === "usage_update") {
      this.lastUsed = update.used;
      this.lastSize = update.size;
      if (this.persistDir) {
        // Load before save so we don't clobber an existing cached summary.
        await this.maybeLoadState();
        await this.saveState();
      }
      return [];
    }
    return [update];
  }

  async pull(below: SessionUpdate[]): Promise<SessionUpdate[]> {
    await this.maybeLoadState();
    this.latestBelow = below.slice();
    if (this.cachedSummary && this.summarizedThrough > 0) {
      const recent = below.slice(this.summarizedThrough);
      return [...this.cachedSummary, ...recent];
    }
    return below;
  }

  get tokensInContext(): number | null {
    return this.lastUsed;
  }

  get contextWindow(): number | null {
    return this.lastSize;
  }

  async prepareTurn(agent: Agent): Promise<void> {
    await this.maybeLoadState();
    // Refresh latestBelow via the chain so the threshold check sees the
    // current event count rather than whatever last pulled.
    if (agent.session?.pull) {
      try {
        await agent.session.pull([]);
      } catch {
        // Fall back to the cached latestBelow snapshot.
      }
    }
    if (this.shouldCompact()) {
      await this.runCompaction(agent.harness, false);
    }
  }

  private shouldCompact(): boolean {
    if (
      this.tokenFraction !== null &&
      this.lastUsed !== null &&
      this.lastSize !== null &&
      this.lastSize > 0
    ) {
      return this.lastUsed >= this.lastSize * this.tokenFraction;
    }
    if (this.tokenThreshold !== null && this.lastUsed !== null) {
      return this.lastUsed >= this.tokenThreshold;
    }
    // Count only new events past the last summary, else we recompact
    // every turn once a summary exists.
    return this.latestBelow.length - this.summarizedThrough >= this.threshold;
  }

  async compactNow(
    harness: Harness | null = null,
  ): Promise<{ before: number; after: number } | null> {
    await this.maybeLoadState();
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
      await this.saveState();
    } finally {
      this.compacting = false;
    }
    const after = (this.cachedSummary?.length ?? 0) + (before - cutoff);
    const info = { before, after };
    this.onCompact?.(info);
    return info;
  }
}

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

export function compactingMemorySession(
  opts: CompactingSessionOptions = {},
): Session {
  return new ChainedSession([
    new CompactingSession(opts),
    new InMemorySession(),
  ]);
}

export function compactingFileSession(
  filePath: string,
  opts: CompactingSessionOptions = {},
): Session {
  return new ChainedSession([
    new CompactingSession(opts),
    new FileSession(filePath),
  ]);
}

export const compactingSessionFactory: SessionFactory = {
  name: "compacting",
  passThrough: true,
  async create(
    config: Record<string, unknown>,
    ctx: FactoryContext,
    _secrets: Record<string, string>,
  ): Promise<Session> {
    const opts: CompactingSessionOptions = {};
    if (typeof config.threshold === "number") opts.threshold = config.threshold;
    if (typeof config.token_threshold === "number") {
      opts.tokenThreshold = config.token_threshold;
    }
    if (typeof config.token_fraction === "number") {
      opts.tokenFraction = config.token_fraction;
    }
    if (typeof config.keep === "number") opts.keep = config.keep;
    if (config.persist === true) {
      const persistDir = path.join(ctx.storage, "compacting");
      await fs.mkdir(persistDir, { recursive: true });
      opts.persistDir = persistDir;
    }
    return new CompactingSession(opts);
  },
};
