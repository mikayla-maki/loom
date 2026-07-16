import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ReadFileTool } from "../src/runtime/builtins/read_file.js";
import type { Agent, ToolContext } from "../src/types/interfaces.js";
import { useTmpDir } from "./helpers/tmp.js";

// Smallest valid PNG: 1x1 transparent pixel.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

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

describe("read_file image support", () => {
  const root = useTmpDir("loom-read-img-");

  it("returns a PNG as an image content block", async () => {
    const file = path.join(root(), "pixel.png");
    await fs.writeFile(file, PNG_BYTES);

    const tool = new ReadFileTool({}, { paths: [root()] });
    const result = await tool.execute({ path: file }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(Array.isArray(result.content)).toBe(true);
    const blocks = result.content as Exclude<typeof result.content, string>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: PNG_BASE64,
    });
    // Display metadata matches the text path.
    expect(result.display?.title).toBe("Read pixel.png");
    expect(result.display?.kind).toBe("read");
  });

  it("bypasses the client readTextFile path for images", async () => {
    const file = path.join(root(), "pixel.png");
    await fs.writeFile(file, PNG_BYTES);

    const ctx = makeCtx();
    ctx.client = {
      capabilities: { fs: { readTextFile: true, writeTextFile: false } },
      readTextFile: async () => {
        throw new Error("readTextFile must not be called for images");
      },
    };
    const tool = new ReadFileTool({}, { paths: [root()] });
    const result = await tool.execute({ path: file }, ctx);

    expect(result.isError).toBeFalsy();
    expect(Array.isArray(result.content)).toBe(true);
  });

  it("detects image extensions case-insensitively", async () => {
    const file = path.join(root(), "SHOUTY.PNG");
    await fs.writeFile(file, PNG_BYTES);

    const tool = new ReadFileTool({}, { paths: [root()] });
    const result = await tool.execute({ path: file }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(Array.isArray(result.content)).toBe(true);
    const blocks = result.content as Exclude<typeof result.content, string>;
    expect(blocks[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("maps jpg/jpeg/gif/webp extensions to their mime types", async () => {
    const cases: Array<[string, string]> = [
      ["a.jpg", "image/jpeg"],
      ["b.jpeg", "image/jpeg"],
      ["c.gif", "image/gif"],
      ["d.webp", "image/webp"],
    ];
    const tool = new ReadFileTool({}, { paths: [root()] });
    for (const [name, mime] of cases) {
      const file = path.join(root(), name);
      // Content bytes are irrelevant to extension detection.
      await fs.writeFile(file, PNG_BYTES);
      const result = await tool.execute({ path: file }, makeCtx());
      expect(result.isError).toBeFalsy();
      const blocks = result.content as Exclude<typeof result.content, string>;
      expect(blocks[0]).toMatchObject({ type: "image", mimeType: mime });
    }
  });

  it("refuses images over 5 MiB with a size error", async () => {
    const file = path.join(root(), "huge.png");
    await fs.writeFile(file, Buffer.alloc(5 * 1024 * 1024 + 1));

    const tool = new ReadFileTool({}, { paths: [root()] });
    const result = await tool.execute({ path: file }, makeCtx());

    expect(result.isError).toBe(true);
    expect(typeof result.content).toBe("string");
    expect(result.content).toContain("huge.png");
    expect(result.content).toMatch(/images over 5 MiB can't be attached/);
  });

  it("still returns text for non-image files", async () => {
    const file = path.join(root(), "note.txt");
    await fs.writeFile(file, "plain text here", "utf8");

    const tool = new ReadFileTool({}, { paths: [root()] });
    const result = await tool.execute({ path: file }, makeCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("plain text here");
  });

  it("mentions viewable images in the tool description", () => {
    const tool = new ReadFileTool({}, { paths: ["./"] });
    expect(tool.description).toMatch(/viewable images/);
    expect(tool.description).toMatch(/5 MiB/);
  });
});
