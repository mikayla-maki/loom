import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { FindTool } from "../src/runtime/builtins/find.js";
import { ReadFileTool } from "../src/runtime/builtins/read_file.js";
import { WriteFileTool } from "../src/runtime/builtins/write_file.js";
import type {
  Agent,
  Session,
  ToolContext,
  TrustedPath,
} from "../src/types/interfaces.js";

let grantedDir: string;
let trustedDir: string;
let forbiddenDir: string;

beforeEach(async () => {
  grantedDir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-grant-"));
  trustedDir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-trust-"));
  forbiddenDir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-forbid-"));
  await fs.writeFile(path.join(grantedDir, "ok.txt"), "from-grant", "utf8");
  await fs.writeFile(path.join(trustedDir, "skill.md"), "from-trust", "utf8");
  await fs.writeFile(path.join(forbiddenDir, "secret.txt"), "private", "utf8");
});

afterEach(async () => {
  await Promise.all([
    fs.rm(grantedDir, { recursive: true, force: true }),
    fs.rm(trustedDir, { recursive: true, force: true }),
    fs.rm(forbiddenDir, { recursive: true, force: true }),
  ]);
});

function makeCtx(session: Session): ToolContext {
  const agent: Agent = {
    manifest: { name: "test", harness: { provider: "test" } },
    harness: { run: async () => ({ stopReason: "end_turn" as const }) },
    session,
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

function sessionWith(trusted: TrustedPath[]): Session {
  return { trustedPaths: () => trusted };
}

describe("read_file honours session.trustedPaths()", () => {
  it("extends the manifest grant with trusted paths while rejecting everything else", async () => {
    const tool = new ReadFileTool({}, { paths: [grantedDir] });
    const ctx = makeCtx(
      sessionWith([
        { path: trustedDir, access: "read", reason: "test fixture" },
      ]),
    );

    const granted = await tool.execute(
      { path: path.join(grantedDir, "ok.txt") },
      ctx,
    );
    expect(granted.isError).toBeFalsy();
    expect(granted.content).toBe("from-grant");

    const trusted = await tool.execute(
      { path: path.join(trustedDir, "skill.md") },
      ctx,
    );
    expect(trusted.isError).toBeFalsy();
    expect(trusted.content).toBe("from-trust");

    const forbidden = await tool.execute(
      { path: path.join(forbiddenDir, "secret.txt") },
      ctx,
    );
    expect(forbidden.isError).toBe(true);
    expect(forbidden.content).toMatch(/outside the granted paths/);
  });

  it("accepts write and read-write trusted paths for reads", async () => {
    const tool = new ReadFileTool({}, { paths: [grantedDir] });
    for (const access of ["write", "read-write"] as const) {
      const ctx = makeCtx(sessionWith([{ path: trustedDir, access }]));
      const result = await tool.execute(
        { path: path.join(trustedDir, "skill.md") },
        ctx,
      );
      expect(result.isError).toBeFalsy();
    }
  });

  it("falls back to the manifest grant when no session declares trustedPaths", async () => {
    const tool = new ReadFileTool({}, { paths: [grantedDir] });
    const ctx = makeCtx({});

    const ok = await tool.execute(
      { path: path.join(grantedDir, "ok.txt") },
      ctx,
    );
    expect(ok.isError).toBeFalsy();

    const bad = await tool.execute(
      { path: path.join(forbiddenDir, "secret.txt") },
      ctx,
    );
    expect(bad.isError).toBe(true);
  });

  it("falls back to the manifest grant when trustedPaths() throws", async () => {
    const tool = new ReadFileTool({}, { paths: [grantedDir] });
    const ctx = makeCtx({
      trustedPaths: () => {
        throw new Error("boom");
      },
    });

    const ok = await tool.execute(
      { path: path.join(grantedDir, "ok.txt") },
      ctx,
    );
    expect(ok.isError).toBeFalsy();

    const bad = await tool.execute(
      { path: path.join(trustedDir, "skill.md") },
      ctx,
    );
    expect(bad.isError).toBe(true);
  });

  it("extends an explicitly-empty manifest grant with trusted paths", async () => {
    const tool = new ReadFileTool({}, { paths: [] });
    const ctx = makeCtx(sessionWith([{ path: trustedDir, access: "read" }]));

    const ok = await tool.execute(
      { path: path.join(trustedDir, "skill.md") },
      ctx,
    );
    expect(ok.isError).toBeFalsy();

    const bad = await tool.execute(
      { path: path.join(grantedDir, "ok.txt") },
      ctx,
    );
    expect(bad.isError).toBe(true);
  });

  it("ignores trusted paths under an unrestricted `*` manifest grant", async () => {
    const tool = new ReadFileTool({}, { paths: "*" });
    const ctx = makeCtx(sessionWith([]));
    const result = await tool.execute(
      { path: path.join(forbiddenDir, "secret.txt") },
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });
});

describe("write_file honours session.trustedPaths() with write-access filtering", () => {
  it("rejects writes to read-only trusted paths but allows write and read-write ones", async () => {
    const readOnlyCtx = makeCtx(
      sessionWith([{ path: trustedDir, access: "read", reason: "skills root" }]),
    );
    const rejected = await new WriteFileTool({}, { paths: [grantedDir] }).execute(
      { path: path.join(trustedDir, "new.txt"), content: "hello" },
      readOnlyCtx,
    );
    expect(rejected.isError).toBe(true);
    expect(rejected.content).toMatch(/outside the granted paths/);

    for (const access of ["write", "read-write"] as const) {
      const ctx = makeCtx(sessionWith([{ path: trustedDir, access }]));
      const file = path.join(trustedDir, `${access}.txt`);
      const result = await new WriteFileTool({}, { paths: [grantedDir] }).execute(
        { path: file, content: "hello" },
        ctx,
      );
      expect(result.isError).toBeFalsy();
      expect(await fs.readFile(file, "utf8")).toBe("hello");
    }
  });
});

describe("find honours session.trustedPaths()", () => {
  it("lists inside trusted directories but rejects roots outside the grant", async () => {
    const ctx = makeCtx(sessionWith([{ path: trustedDir, access: "read" }]));

    const listed = await new FindTool({}, { paths: [grantedDir] }).execute(
      { pattern: "*.md", root: trustedDir },
      ctx,
    );
    expect(listed.isError).toBeFalsy();
    expect(listed.content).toContain("skill.md");

    const rejected = await new FindTool({}, { paths: [grantedDir] }).execute(
      { pattern: "*", root: forbiddenDir },
      ctx,
    );
    expect(rejected.isError).toBe(true);
  });
});
