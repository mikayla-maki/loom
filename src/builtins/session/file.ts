/**
 * File-backed Session — JSONL append log.
 *
 * Config (all optional):
 *   - `path`: where to write. Absolute paths are used as-is; relative
 *     paths anchor at the manifest dir. When omitted, defaults to
 *     `<ctx.storage>/session.jsonl` — the per-agent storage root Loom
 *     guarantees exists, so the file follows the agent across `cd`s
 *     and survives deletes of the manifest's containing directory.
 *     Override with `LOOM_DATA_HOME` to relocate it for a one-off run,
 *     or set `path = "./somewhere.jsonl"` to pin it next to the manifest.
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
import { expandHome } from "../../internal/util.js";
import type {
  FactoryContext,
  Session,
  SessionFactory,
} from "../../types/interfaces.js";
import type { SessionUpdate } from "../../types/acp.js";

/** Filename used under `ctx.storage` when no `path` is configured. */
const DEFAULT_FILENAME = "session.jsonl";

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
    const cache = await this.ensureCache();

    if (isCoalescable(update)) {
      const head = this.pending[0];
      // Same kind as buffer head → keep collecting; no disk write.
      if (head === undefined || sameKind(head, update)) {
        this.pending.push(update);
        await this.writeChain;
        return [update];
      }
      // Different coalescable kind → boundary; flush and start fresh.
      this.flushPending(cache);
      this.pending.push(update);
      await this.writeChain;
      return [update];
    }

    // Non-coalescable → boundary; flush, then write this event verbatim.
    this.flushPending(cache);
    cache.push(update);
    this.queueAppend(update);
    await this.writeChain;
    return [update];
  }

  async pull(_below: SessionUpdate[]): Promise<SessionUpdate[]> {
    const cache = await this.ensureCache();
    if (this.pending.length > 0) {
      // Surface the in-flight buffer (merged) so in-process readers see
      // the message being produced this turn.
      return [...cache, mergeChunks(this.pending)];
    }
    return [...cache];
  }

  async close(): Promise<void> {
    if (this.pending.length > 0) {
      // close() may run before any push()/pull(), so the cache might
      // still be null — but in that case the buffer is empty by
      // construction, so we can short-circuit (handled by the guard
      // above).
      this.flushPending(await this.ensureCache());
    }
    await this.writeChain;
  }

  /** Merge pending chunks, append to cache, queue disk write, reset buffer. */
  private flushPending(cache: SessionUpdate[]): void {
    if (this.pending.length === 0) return;
    const merged = mergeChunks(this.pending);
    cache.push(merged);
    this.queueAppend(merged);
    this.pending = [];
  }

  private async ensureCache(): Promise<SessionUpdate[]> {
    if (this.cache === null) await this.load();
    if (this.cache === null) {
      // `load()` always assigns `this.cache` (even the ENOENT branch).
      throw new Error(
        "FileSession: internal invariant violated — cache unset after load()",
      );
    }
    return this.cache;
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

/**
 * Merge a run of same-kind coalescable chunks by concatenating text.
 * Callers must ensure `chunks` is non-empty (every internal call site
 * checks `pending.length > 0` first); we still guard at runtime so
 * the invariant is loud if it ever breaks.
 */
function mergeChunks(chunks: SessionUpdate[]): SessionUpdate {
  const first = chunks[0];
  if (first === undefined) {
    throw new Error("mergeChunks called with an empty buffer");
  }
  if (chunks.length === 1) return first;
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
    if (p === undefined) {
      // No explicit path — default to the per-agent storage root so
      // the session log follows the agent's identity, not its on-disk
      // location. Matches the convention used by `notes-provider` and
      // other plugins that own state.
      return new FileSession(path.join(ctx.storage, DEFAULT_FILENAME));
    }
    if (typeof p !== "string" || !p) {
      throw new ManifestError(
        `[session] provider 'file': 'path' must be a non-empty string when set ` +
          `(omit it entirely to default to <ctx.storage>/${DEFAULT_FILENAME}).`,
      );
    }
    // `expandHome` first so `~/path/to/file.jsonl` doesn't end up as
    // `<manifestDir>/~/path/to/file.jsonl`.
    const expanded = expandHome(p);
    const abs = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(ctx.manifestDir, expanded);
    return new FileSession(abs);
  },
};
