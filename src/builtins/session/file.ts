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

const DEFAULT_FILENAME = "session.jsonl";

const COALESCABLE_KINDS = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "user_message_chunk",
]);

export class FileSession implements Session {
  private cache: SessionUpdate[] | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private pending: SessionUpdate[] = [];

  constructor(public readonly filePath: string) {}

  async push(update: SessionUpdate): Promise<SessionUpdate[]> {
    const cache = await this.ensureCache();

    if (isCoalescable(update)) {
      const head = this.pending[0];
      if (head === undefined || sameKind(head, update)) {
        this.pending.push(update);
        await this.writeChain;
        return [update];
      }
      this.flushPending(cache);
      this.pending.push(update);
      await this.writeChain;
      return [update];
    }

    this.flushPending(cache);
    cache.push(update);
    this.queueAppend(update);
    await this.writeChain;
    return [update];
  }

  async pull(_below: SessionUpdate[]): Promise<SessionUpdate[]> {
    const cache = await this.ensureCache();
    if (this.pending.length > 0) {
      return [...cache, mergeChunks(this.pending)];
    }
    return [...cache];
  }

  async close(): Promise<void> {
    if (this.pending.length > 0) {
      this.flushPending(await this.ensureCache());
    }
    await this.writeChain;
  }

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
      throw new Error(
        "FileSession: internal invariant violated — cache unset after load()",
      );
    }
    return this.cache;
  }

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
        continue;
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

function mergeChunks(chunks: SessionUpdate[]): SessionUpdate {
  const first = chunks[0];
  if (first === undefined) {
    throw new Error("mergeChunks called with an empty buffer");
  }
  if (chunks.length === 1) return first;
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
      return new FileSession(path.join(ctx.storage, DEFAULT_FILENAME));
    }
    if (typeof p !== "string" || !p) {
      throw new ManifestError(
        `[session] provider 'file': 'path' must be a non-empty string when set ` +
          `(omit it entirely to default to <ctx.storage>/${DEFAULT_FILENAME}).`,
      );
    }
    // Expand `~` before resolving, else it anchors under manifestDir.
    const expanded = expandHome(p);
    const abs = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(ctx.manifestDir, expanded);
    return new FileSession(abs);
  },
};
