/**
 * Newline-delimited JSON framing — one JSON message per UTF-8 line. The
 * simplest framing that works over stdio and Unix sockets.
 */

import type { Readable, Writable } from "node:stream";

export interface MessageStream {
  write(line: string): void;
  messages(): AsyncIterable<unknown>;
  close(): void;
}

export function ndjsonStream(input: Readable, output: Writable): MessageStream {
  let buf = "";
  const queue: unknown[] = [];
  let resolveNext: (() => void) | null = null;
  let closed = false;

  const wakeUp = () => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        queue.push(JSON.parse(line));
      } catch {
        queue.push(line);
      }
      wakeUp();
    }
  });
  input.on("end", () => {
    closed = true;
    wakeUp();
  });
  input.on("close", () => {
    closed = true;
    wakeUp();
  });

  return {
    write(line: string) {
      output.write(line.endsWith("\n") ? line : line + "\n");
    },
    async *messages() {
      while (true) {
        const m = queue.shift();
        if (m !== undefined) {
          yield m;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    },
    close() {
      closed = true;
      try {
        output.end();
      } catch {
        /* ignore */
      }
    },
  };
}
