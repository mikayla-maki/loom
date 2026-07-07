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

// write_file has no OS sandbox; it defends the path-grant allowlist lexically
// after realpath. Two aliasing escapes slip past a pure realpath check.
describe("write_file refuses symlink and hard-link escapes", () => {
  const root = useTmpDir("loom-write-sec-");

  async function grantAndOutside() {
    const grant = path.join(root(), "grant");
    const outside = path.join(root(), "outside");
    await fs.mkdir(grant, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    return { grant, outside };
  }

  it("refuses a DANGLING terminal symlink pointing out of the grant", async () => {
    // realpath fails on a dangling link, so canonicalizeForGrant re-joins the
    // tail onto the in-grant ancestor and the lexical check passes — the write
    // would then follow the link out. O_NOFOLLOW must stop it.
    const { grant, outside } = await grantAndOutside();
    const secret = path.join(outside, "secret.txt"); // does not exist yet
    const link = path.join(grant, "escape.txt");
    await fs.symlink(secret, link);

    const tool = new WriteFileTool({}, { paths: [grant] });
    const result = await tool.execute(
      { path: link, content: "PWNED" },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/symlink/i);
    // The write must not have followed the link out of the grant.
    await expect(fs.readFile(secret, "utf8")).rejects.toThrow();
  });

  it("refuses a terminal symlink to an EXISTING file outside the grant", async () => {
    // This one realpath already catches; assert the outside file is untouched.
    const { grant, outside } = await grantAndOutside();
    const secret = path.join(outside, "secret.txt");
    await fs.writeFile(secret, "ORIGINAL");
    const link = path.join(grant, "escape.txt");
    await fs.symlink(secret, link);

    const tool = new WriteFileTool({}, { paths: [grant] });
    const result = await tool.execute(
      { path: link, content: "PWNED" },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(await fs.readFile(secret, "utf8")).toBe("ORIGINAL");
  });

  it("refuses to write a symlink swapped into the target path (TOCTOU)", async () => {
    // Stand-in for the check-then-write race: whatever passed the allowlist
    // check, if the final component is a symlink at open time the fd-based
    // write refuses it rather than following it. This is why the write goes
    // through the no-follow fd and never re-resolves the path.
    const { grant, outside } = await grantAndOutside();
    const secret = path.join(outside, "secret.txt");
    await fs.writeFile(secret, "ORIGINAL");
    const target = path.join(grant, "note.txt");
    await fs.symlink(secret, target); // symlink now sits at the write target

    const tool = new WriteFileTool({}, { paths: [grant] });
    const result = await tool.execute(
      { path: target, content: "PWNED", append: true },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(await fs.readFile(secret, "utf8")).toBe("ORIGINAL");
  });

  it("refuses a hard link that aliases a file outside the grant", async () => {
    // realpath cannot see a hard link — the in-grant name is a real path. The
    // fstat link count is the only tell, so nlink > 1 regular files are refused.
    const { grant, outside } = await grantAndOutside();
    const secret = path.join(outside, "secret.txt");
    await fs.writeFile(secret, "ORIGINAL");
    const alias = path.join(grant, "alias.txt");
    await fs.link(secret, alias); // hard link inside the grant

    const tool = new WriteFileTool({}, { paths: [grant] });
    const result = await tool.execute(
      { path: alias, content: "PWNED" },
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/hard link/i);
    expect(await fs.readFile(secret, "utf8")).toBe("ORIGINAL");
  });

  it("still overwrites and appends to a normal in-grant file", async () => {
    const { grant } = await grantAndOutside();
    const tool = new WriteFileTool({}, { paths: [grant] });
    const file = path.join(grant, "f.txt");

    let r = await tool.execute({ path: file, content: "one" }, makeCtx());
    expect(r.isError).toBeFalsy();
    expect(await fs.readFile(file, "utf8")).toBe("one");

    r = await tool.execute({ path: file, content: "two" }, makeCtx());
    expect(r.isError).toBeFalsy();
    expect(await fs.readFile(file, "utf8")).toBe("two");

    r = await tool.execute(
      { path: file, content: "three", append: true },
      makeCtx(),
    );
    expect(r.isError).toBeFalsy();
    expect(await fs.readFile(file, "utf8")).toBe("twothree");
  });

  it("writes through an in-grant symlink DIRECTORY in the path", async () => {
    // Only the FINAL component is no-follow. An intermediate symlinked dir that
    // resolves back inside the grant must keep working (realpath handles it).
    const { grant } = await grantAndOutside();
    const realDir = path.join(grant, "real");
    await fs.mkdir(realDir, { recursive: true });
    const linkDir = path.join(grant, "linkdir");
    await fs.symlink(realDir, linkDir);

    const tool = new WriteFileTool({}, { paths: [grant] });
    const file = path.join(linkDir, "note.txt");
    const result = await tool.execute(
      { path: file, content: "hi" },
      makeCtx(),
    );

    expect(result.isError).toBeFalsy();
    expect(await fs.readFile(path.join(realDir, "note.txt"), "utf8")).toBe("hi");
  });
});
