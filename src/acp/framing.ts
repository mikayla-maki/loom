/**
 * Newline-delimited JSON framing for ACP over a Duplex/Readable+Writable pair.
 *
 * Each JSON-RPC message is one line of UTF-8 JSON terminated by `\n`. This is
 * the simplest framing that works over stdio and Unix sockets; it matches
 * what most ACP implementations (zed-style) use.
 */

export interface MessageStream {
  write(line: string): void;
  /**
   * Iterate received messages. Each item is an already-parsed object (or a
   * string for non-JSON lines, which the caller is expected to ignore or
   * report).
   */
  messages(): AsyncIterable<unknown>;
  close(): void;
}

import { Readable, Writable } from "node:stream";

export function ndjsonStream(input: Readable, output: Writable): MessageStream {
  let buf = "";
  let queue: unknown[] = [];
  let resolveNext: (() => void) | null = null;
  let closed = false;

  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        queue.push(JSON.parse(line));
      } catch {
        queue.push(line);
      }
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    }
  });
  input.on("end", () => {
    closed = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  });
  input.on("close", () => {
    closed = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  });

  return {
    write(line: string) {
      output.write(line.endsWith("\n") ? line : line + "\n");
    },
    async *messages(): AsyncIterable<unknown> {
      while (true) {
        if (queue.length > 0) {
          const m = queue.shift()!;
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
        // ignore
      }
    },
  };
}
