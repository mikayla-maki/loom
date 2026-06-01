import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { WriteFileTool } from "../src/runtime/builtins/write_file.js";
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

describe("write_file creates missing parent directories", () => {
  const root = useTmpDir("loom-write-");

  it("writes and appends through parent directories that do not yet exist", async () => {
    const tool = new WriteFileTool({}, { paths: [root()] });

    const written = path.join(root(), "nested", "deep", "note.md");
    const writeResult = await tool.execute(
      { path: written, content: "hello", create_dirs: true },
      makeCtx(),
    );
    expect(writeResult.isError).toBeFalsy();
    expect(await fs.readFile(written, "utf8")).toBe("hello");

    const appended = path.join(root(), "fresh", "log.txt");
    const appendResult = await tool.execute(
      { path: appended, content: "first", append: true, create_dirs: true },
      makeCtx(),
    );
    expect(appendResult.isError).toBeFalsy();
    expect(await fs.readFile(appended, "utf8")).toBe("first");
  });
});
