/**
 * File-backed Session — JSONL append log.
 *
 * Config:
 *   path: string  — path to the JSONL file (relative to manifest dir)
 *
 * Leaf session in the push/pull model: persists events on push,
 * returns the loaded log on pull. The cache is hydrated lazily on
 * the first call and kept in sync with appends.
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

export class FileSession implements Session {
  private cache: SessionUpdate[] | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(public readonly filePath: string) {}

  async push(update: SessionUpdate): Promise<SessionUpdate[]> {
    if (!this.cache) await this.load();
    this.cache!.push(update);
    const line = JSON.stringify(update) + "\n";
    // Serialize writes so concurrent appends don't interleave on disk.
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, line, "utf8");
    });
    await this.writeChain;
    return [update];
  }

  async pull(_below: SessionUpdate[]): Promise<SessionUpdate[]> {
    if (!this.cache) await this.load();
    return [...this.cache!];
  }

  async close(): Promise<void> {
    await this.writeChain;
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
