import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { EditFileTool } from "../src/runtime/builtins/edit_file.js";
import type { Agent, ToolContext } from "../src/types/interfaces.js";
import { useTmpDir } from "./helpers/tmp.js";

function makeCtx(): ToolContext {
  const agent: Agent = {
    manifest: { name: "test", harness: { provider: "test" } },
    harness: { run: async () => ({ stopReason: "end_turn" as const }) },
    session: {},
    systemPromptCore: "",
  };
  return {
    secrets: {},
    abortSignal: new AbortController().signal,
    requestPermission: async () => ({
      outcome: { outcome: "cancelled" as const },
    }),
    agent,
  };
}

describe("edit_file applies exact-text replacements", () => {
  const root = useTmpDir("loom-edit-");

  it("applies a single edit", async () => {
    const tool = new EditFileTool({}, { paths: [root()] });
    const file = path.join(root(), "note.txt");
    await fs.writeFile(file, "hello world", "utf8");

    const result = await tool.execute(
      { path: file, edits: [{ old_text: "world", new_text: "loom" }] },
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    expect(await fs.readFile(file, "utf8")).toBe("hello loom");
  });

  it("applies multiple non-overlapping edits against the original content", async () => {
    const tool = new EditFileTool({}, { paths: [root()] });
    const file = path.join(root(), "note.txt");
    await fs.writeFile(file, "alpha beta gamma", "utf8");

    const result = await tool.execute(
      {
        path: file,
        edits: [
          { old_text: "alpha", new_text: "ONE" },
          { old_text: "gamma", new_text: "THREE" },
        ],
      },
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    expect(await fs.readFile(file, "utf8")).toBe("ONE beta THREE");
  });

  it("errors when old_text matches more than once", async () => {
    const tool = new EditFileTool({}, { paths: [root()] });
    const file = path.join(root(), "note.txt");
    await fs.writeFile(file, "dup dup", "utf8");

    const result = await tool.execute(
      { path: file, edits: [{ old_text: "dup", new_text: "x" }] },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    // Original content is left untouched.
    expect(await fs.readFile(file, "utf8")).toBe("dup dup");
  });

  it("errors when old_text is not found", async () => {
    const tool = new EditFileTool({}, { paths: [root()] });
    const file = path.join(root(), "note.txt");
    await fs.writeFile(file, "hello world", "utf8");

    const result = await tool.execute(
      { path: file, edits: [{ old_text: "missing", new_text: "x" }] },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("hello world");
  });

  it("denies a path outside the granted paths", async () => {
    const tool = new EditFileTool({}, { paths: [root()] });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "loom-edit-out-"));
    try {
      const file = path.join(outside, "note.txt");
      await fs.writeFile(file, "hello world", "utf8");

      const result = await tool.execute(
        { path: file, edits: [{ old_text: "world", new_text: "loom" }] },
        makeCtx(),
      );
      expect(result.isError).toBe(true);
      // The denied edit must not modify the out-of-grant file.
      expect(await fs.readFile(file, "utf8")).toBe("hello world");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
