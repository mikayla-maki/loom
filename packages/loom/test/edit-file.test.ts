import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { EditFileTool } from "../src/runtime/builtins/edit_file.js";
import type { Agent, ToolContext } from "../src/types/interfaces.js";
import { useTmpDir, withTmpDir } from "./helpers/tmp.js";

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

  // A tool granted the tmp root plus a note file inside it.
  async function setup(content: string) {
    const tool = new EditFileTool({}, { paths: [root()] });
    const file = path.join(root(), "note.txt");
    await fs.writeFile(file, content, "utf8");
    return { tool, file };
  }

  it("applies a single edit", async () => {
    const { tool, file } = await setup("hello world");
    const result = await tool.execute(
      { path: file, edits: [{ old_text: "world", new_text: "loom" }] },
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    expect(await fs.readFile(file, "utf8")).toBe("hello loom");
  });

  it("applies multiple non-overlapping edits against the original content", async () => {
    const { tool, file } = await setup("alpha beta gamma");
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
    const { tool, file } = await setup("dup dup");
    const result = await tool.execute(
      { path: file, edits: [{ old_text: "dup", new_text: "x" }] },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    // Failed edit leaves the file untouched.
    expect(await fs.readFile(file, "utf8")).toBe("dup dup");
  });

  it("errors when old_text is not found", async () => {
    const { tool, file } = await setup("hello world");
    const result = await tool.execute(
      { path: file, edits: [{ old_text: "missing", new_text: "x" }] },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("hello world");
  });

  it("denies a path outside the granted paths", async () => {
    // Tool granted only `root()`; the target file lives elsewhere.
    await withTmpDir("loom-edit-out-", async (outside) => {
      const tool = new EditFileTool({}, { paths: [root()] });
      const file = path.join(outside, "note.txt");
      await fs.writeFile(file, "hello world", "utf8");

      const result = await tool.execute(
        { path: file, edits: [{ old_text: "world", new_text: "loom" }] },
        makeCtx(),
      );
      expect(result.isError).toBe(true);
      expect(await fs.readFile(file, "utf8")).toBe("hello world");
    });
  });
});
