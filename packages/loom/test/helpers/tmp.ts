/**
 * Shared test helpers for ephemeral temp directories.
 *
 * Two patterns:
 *   - `useTmpDir(prefix)` — declarative; allocates a fresh dir per test
 *     in the surrounding describe and cleans up in afterEach.
 *   - `withTmpDir(prefix, fn)` — imperative; one-shot dir for a single
 *     callback. Use when a test needs multiple independent dirs, or
 *     when you're not inside a describe block.
 */

import { afterEach, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Allocates a fresh temp directory before each test in the surrounding
 * describe and removes it afterwards. Returns a getter so the path is
 * always the current test's directory.
 *
 * ```ts
 * describe("widget", () => {
 *   const tmp = useTmpDir("loom-widget-");
 *   it("does a thing", async () => {
 *     await fs.writeFile(path.join(tmp(), "f.txt"), "hi");
 *   });
 * });
 * ```
 */
export function useTmpDir(prefix = "loom-"): () => string {
  let dir = "";
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  });
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = "";
  });
  return () => dir;
}

/**
 * Runs `fn` with a fresh temp directory and guarantees cleanup. The
 * callback form is convenient for tests that need more than one
 * isolated dir, or for code paths outside a describe block.
 */
export async function withTmpDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
