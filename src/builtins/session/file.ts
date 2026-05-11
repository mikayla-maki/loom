/**
 * File-backed Session — JSONL append log. Config: `path` (relative to
 * manifest dir).
 *
 * Chunk coalescing: consecutive same-kind chunks of `agent_message_chunk`,
 * `agent_thought_chunk`, `user_message_chunk` are buffered in memory and
 * merged into one event at the next boundary (any non-coalescable event,
 * a coalescable event of a different kind, or `close()`). A mid-stream
 * crash therefore loses the partial message; `pull()` includes the
 * pending buffer (merged) so in-process readers see the in-flight message.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ManifestError } from "../../errors.js";
import type {
  FactoryContext,
  Session,
  SessionFactory,
} from "../../types/interfaces.js";
import type { SessionUpdate } from "../../types/acp.js";

/** Text-content event kinds that get concatenated when adjacent. */
const COALESCABLE_KINDS = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "user_message_chunk",
]);

export class FileSession implements Session {
  /** Coalesced events loaded from disk + flushed-from-buffer events. */
  private cache: SessionUpdate[] | null = null;
  /** Serialised disk write queue. */
  private writeChain: Promise<void> = Promise.resolve();
  /** Buffer of consecutive same-kind coalescable chunks awaiting flush. */
  private pending: SessionUpdate[] = [];

  constructor(public readonly filePath: string) {}

  async push(update: SessionUpdate): Promise<SessionUpdate[]> {
    if (!this.cache) await this.load();

    if (isCoalescable(update)) {
      // Same kind as buffer head → keep collecting; no disk write.
      if (this.pending.length === 0 || sameKind(this.pending[0]!, update)) {
        this.pending.push(update);
        await this.writeChain;
        return [update];
      }
      // Different coalescable kind → boundary; flush and start fresh.
      this.flushPending();
      this.pending.push(update);
      await this.writeChain;
      return [update];
    }

    // Non-coalescable → boundary; flush, then write this event verbatim.
    this.flushPending();
    this.cache!.push(update);
    this.queueAppend(update);
    await this.writeChain;
    return [update];
  }

  async pull(_below: SessionUpdate[]): Promise<SessionUpdate[]> {
    if (!this.cache) await this.load();
    if (this.pending.length > 0) {
      // Surface the in-flight buffer (merged) so in-process readers see
      // the message being produced this turn.
      return [...this.cache!, mergeChunks(this.pending)];
    }
    return [...this.cache!];
  }

  async close(): Promise<void> {
    this.flushPending();
    await this.writeChain;
  }

  /** Merge pending chunks, append to cache, queue disk write, reset buffer. */
  private flushPending(): void {
    if (this.pending.length === 0) return;
    const merged = mergeChunks(this.pending);
    this.cache!.push(merged);
    this.queueAppend(merged);
    this.pending = [];
  }

  /** Schedule a JSONL append; serialised through `writeChain`. */
  private queueAppend(update: SessionUpdate): void {
    const line = JSON.stringify(update) + "\n";
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, line, "utf8");
    });
  }

  private async load(): Promise<void> {
    let text = "";
    try {
      text = await fs.readFile(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = [];
        return;
      }
      throw e;
    }
    const lines = text.split("\n").filter((l) => l.length > 0);
    const out: SessionUpdate[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as SessionUpdate);
      } catch {
        // skip corrupted lines
      }
    }
    this.cache = out;
  }
}

function isCoalescable(update: SessionUpdate): boolean {
  return COALESCABLE_KINDS.has(update.sessionUpdate);
}

function sameKind(a: SessionUpdate, b: SessionUpdate): boolean {
  return a.sessionUpdate === b.sessionUpdate;
}

/** Merge a run of same-kind coalescable chunks by concatenating text. */
function mergeChunks(chunks: SessionUpdate[]): SessionUpdate {
  if (chunks.length === 1) return chunks[0]!;
  const first = chunks[0]!;
  // All coalescable kinds share `{ sessionUpdate, content: { type: "text", text } }`.
  let text = "";
  for (const c of chunks) {
    if (
      c.sessionUpdate === "agent_message_chunk" ||
      c.sessionUpdate === "agent_thought_chunk" ||
      c.sessionUpdate === "user_message_chunk"
    ) {
      if (c.content.type === "text") text += c.content.text;
    }
  }
  return {
    sessionUpdate: first.sessionUpdate,
    content: { type: "text", text },
  } as SessionUpdate;
}

export const fileSessionFactory: SessionFactory = {
  name: "file",
  create(
    config: Record<string, unknown>,
    ctx: FactoryContext,
    _secrets: Record<string, string>,
  ): Session {
    const p = config.path;
    if (typeof p !== "string" || !p) {
      throw new ManifestError(
        `[session] provider 'file' requires config 'path'`,
      );
    }
    const abs = path.isAbsolute(p) ? p : path.resolve(ctx.manifestDir, p);
    return new FileSession(abs);
  },
};
