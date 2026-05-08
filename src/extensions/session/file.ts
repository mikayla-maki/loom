/**
 * File-backed Session — JSONL append log with chunk coalescing.
 *
 * Config:
 *   path: string  — path to the JSONL file (relative to manifest dir)
 *
 * Leaf session in the push/pull model. Events get persisted on push,
 * the loaded log gets returned on pull.
 *
 * ─── Chunk coalescing ──────────────────────────────────────────────
 *
 * Streaming harnesses emit `agent_message_chunk` (and the user/thought
 * variants) in many small fragments — sometimes single tokens. Writing
 * each fragment as its own JSONL line bloats the file and makes it
 * unreadable. FileSession buffers consecutive coalescable chunks of the
 * same kind in memory and merges them into one event on the next
 * "boundary": any non-coalescable event (tool call, stop, usage, etc.)
 * or a coalescable event of a different kind. Plus on `close()`.
 *
 * Coalescable kinds: `agent_message_chunk`, `agent_thought_chunk`,
 * `user_message_chunk`. All carry text-only content; merging concatenates.
 *
 * Trade-off: an in-flight chunk run that hasn't hit a boundary won't be
 * on disk yet, so a hard crash mid-stream loses the partial message.
 * That's the explicit design — users only persist completed messages.
 * In-memory `pull()` includes the pending buffer (merged) so the
 * harness sees the in-progress message during the same process.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ManifestError } from "../../errors.js";
import type {
  ExtensionContext,
  Session,
  SessionFactory,
} from "../../types/interfaces.js";
import type { SessionUpdate } from "../../types/acp.js";

/** Event kinds whose `content` is text and that benefit from concatenation. */
const COALESCABLE_KINDS = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "user_message_chunk",
]);

export class FileSession implements Session {
  /** Coalesced events loaded from disk + flushed-from-buffer events. */
  private cache: SessionUpdate[] | null = null;
  /** Disk write queue — serialised so concurrent flushes don't interleave. */
  private writeChain: Promise<void> = Promise.resolve();
  /**
   * In-flight buffer of consecutive same-kind coalescable chunks. Empty
   * unless the most recent push was coalescable and no boundary has
   * landed since.
   */
  private pending: SessionUpdate[] = [];

  constructor(public readonly filePath: string) {}

  async push(update: SessionUpdate): Promise<SessionUpdate[]> {
    if (!this.cache) await this.load();

    if (isCoalescable(update)) {
      // Same kind as the buffer head → keep collecting; no disk write.
      if (this.pending.length === 0 || sameKind(this.pending[0]!, update)) {
        this.pending.push(update);
        await this.writeChain; // wait on any prior flush
        return [update];
      }
      // Different coalescable kind → boundary. Flush the buffer, start
      // a fresh one with this event.
      this.flushPending();
      this.pending.push(update);
      await this.writeChain;
      return [update];
    }

    // Non-coalescable event → boundary. Flush the buffer, then write
    // this event as its own line.
    this.flushPending();
    this.cache!.push(update);
    this.queueAppend(update);
    await this.writeChain;
    return [update];
  }

  async pull(_below: SessionUpdate[]): Promise<SessionUpdate[]> {
    if (!this.cache) await this.load();
    if (this.pending.length > 0) {
      // Surface the in-flight pending buffer as if it were already
      // coalesced — the harness sees the in-progress message it just
      // produced on this turn.
      return [...this.cache!, mergeChunks(this.pending)];
    }
    return [...this.cache!];
  }

  async close(): Promise<void> {
    // Final boundary: any unfinished pending run gets flushed to disk.
    this.flushPending();
    await this.writeChain;
  }

  /**
   * If the pending buffer has chunks, merge them into one event,
   * append it to the cache, and queue a disk write. Reset the buffer.
   */
  private flushPending(): void {
    if (this.pending.length === 0) return;
    const merged = mergeChunks(this.pending);
    this.cache!.push(merged);
    this.queueAppend(merged);
    this.pending = [];
  }

  /** Schedule a JSONL append. Serialised through `writeChain`. */
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

/**
 * Merge a run of same-kind coalescable chunks into one event by
 * concatenating their text content. Single-element runs are returned
 * unchanged (no allocation needed).
 */
function mergeChunks(chunks: SessionUpdate[]): SessionUpdate {
  if (chunks.length === 1) return chunks[0]!;
  const first = chunks[0]!;
  // All coalescable kinds share the shape `{ sessionUpdate, content: { type: "text", text } }`.
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
    ctx: ExtensionContext,
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
