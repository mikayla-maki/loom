/**
 * Path-aware tools (`read_file`, `write_file`, `find`) must honour
 * `Session.trustedPaths()`: the effective allowlist at execute time
 * is the manifest grant unioned with session-declared trusted paths
 * (filtered by access semantics — read tools accept any access,
 * write tools require write or read-write).
 *
 * `bash` deliberately does NOT honour `trustedPaths` to preserve its
 * sandbox — that property is tested separately.
 */

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

let TMP_GRANTED: string;
let TMP_TRUSTED: string;
let TMP_FORBIDDEN: string;

beforeEach(async () => {
  TMP_GRANTED = await fs.mkdtemp(path.join(os.tmpdir(), "loom-grant-"));
  TMP_TRUSTED = await fs.mkdtemp(path.join(os.tmpdir(), "loom-trust-"));
  TMP_FORBIDDEN = await fs.mkdtemp(path.join(os.tmpdir(), "loom-forbid-"));
  await fs.writeFile(path.join(TMP_GRANTED, "ok.txt"), "from-grant", "utf8");
  await fs.writeFile(path.join(TMP_TRUSTED, "skill.md"), "from-trust", "utf8");
  await fs.writeFile(
    path.join(TMP_FORBIDDEN, "secret.txt"),
    "private",
    "utf8",
  );
});

afterEach(async () => {
  await Promise.all([
    fs.rm(TMP_GRANTED, { recursive: true, force: true }),
    fs.rm(TMP_TRUSTED, { recursive: true, force: true }),
    fs.rm(TMP_FORBIDDEN, { recursive: true, force: true }),
  ]);
});

function makeCtx(session: Session): ToolContext {
  const agent: Agent = {
    harness: { run: async () => ({ stopReason: "end_turn" as const }) },
    session,
    systemPromptCore: "",
    agentName: "test",
  };
  return {
    secrets: {},
    abortSignal: new AbortController().signal,
    requestPermission: async () => ({ decision: "deny" as const }),
    agent,
  };
}

function sessionWith(trusted: TrustedPath[]): Session {
  return {
    trustedPaths: () => trusted,
  };
}

describe("read_file honours session.trustedPaths()", () => {
  it("allows reads inside a trusted path even when not in the manifest grant", async () => {
    const tool = new ReadFileTool({}, { paths: [TMP_GRANTED] });
    const ctx = makeCtx(
      sessionWith([
        { path: TMP_TRUSTED, access: "read", reason: "test fixture" },
      ]),
    );
    const result = await tool.execute(
      { path: path.join(TMP_TRUSTED, "skill.md") },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("from-trust");
  });

  it("still rejects paths outside both the grant and trusted set", async () => {
    const tool = new ReadFileTool({}, { paths: [TMP_GRANTED] });
    const ctx = makeCtx(
      sessionWith([{ path: TMP_TRUSTED, access: "read" }]),
    );
    const result = await tool.execute(
      { path: path.join(TMP_FORBIDDEN, "secret.txt") },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the granted paths/);
  });

  it("read access tools accept write and read-write trusted paths too", async () => {
    // A trusted path with `write` access still permits reads
    // (write implies the ability to read).
    const tool = new ReadFileTool({}, { paths: [TMP_GRANTED] });
    const ctx = makeCtx(
      sessionWith([{ path: TMP_TRUSTED, access: "write" }]),
    );
    const result = await tool.execute(
      { path: path.join(TMP_TRUSTED, "skill.md") },
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });

  it("still respects the manifest grant when no session is present", async () => {
    // Agent ref doesn't carry a session that declares trustedPaths.
    const tool = new ReadFileTool({}, { paths: [TMP_GRANTED] });
    const ctx = makeCtx({});
    const ok = await tool.execute(
      { path: path.join(TMP_GRANTED, "ok.txt") },
      ctx,
    );
    expect(ok.isError).toBeFalsy();
    const bad = await tool.execute(
      { path: path.join(TMP_FORBIDDEN, "secret.txt") },
      ctx,
    );
    expect(bad.isError).toBe(true);
  });

  it("a session whose trustedPaths() throws falls back to the manifest grant", async () => {
    const tool = new ReadFileTool({}, { paths: [TMP_GRANTED] });
    const ctx = makeCtx({
      trustedPaths: () => {
        throw new Error("boom");
      },
    });
    // Manifest grant still works.
    const ok = await tool.execute(
      { path: path.join(TMP_GRANTED, "ok.txt") },
      ctx,
    );
    expect(ok.isError).toBeFalsy();
    // Trusted path is treated as not present.
    const bad = await tool.execute(
      { path: path.join(TMP_TRUSTED, "skill.md") },
      ctx,
    );
    expect(bad.isError).toBe(true);
  });

  it("an explicitly-empty manifest grant + a trusted path → only the trusted path works", async () => {
    // `paths: []` is the explicit-no-access form. Trusted paths still
    // extend it (skills + locked-down manifest is a valid combo).
    const tool = new ReadFileTool({}, { paths: [] });
    const ctx = makeCtx(
      sessionWith([{ path: TMP_TRUSTED, access: "read" }]),
    );
    const ok = await tool.execute(
      { path: path.join(TMP_TRUSTED, "skill.md") },
      ctx,
    );
    expect(ok.isError).toBeFalsy();
    const bad = await tool.execute(
      { path: path.join(TMP_GRANTED, "ok.txt") },
      ctx,
    );
    expect(bad.isError).toBe(true);
  });

  it("a `*` manifest grant ignores trusted paths (already unrestricted)", async () => {
    const tool = new ReadFileTool({}, { paths: "*" });
    const ctx = makeCtx(sessionWith([])); // no trusted paths
    const result = await tool.execute(
      { path: path.join(TMP_FORBIDDEN, "secret.txt") },
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });
});

describe("write_file honours session.trustedPaths() with write-access filtering", () => {
  it("rejects writes to read-only trusted paths", async () => {
    const tool = new WriteFileTool({}, { paths: [TMP_GRANTED] });
    const ctx = makeCtx(
      sessionWith([
        { path: TMP_TRUSTED, access: "read", reason: "skills root" },
      ]),
    );
    const result = await tool.execute(
      {
        path: path.join(TMP_TRUSTED, "new.txt"),
        content: "hello",
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the granted paths/);
  });

  it("allows writes to trusted paths advertised with write access", async () => {
    const tool = new WriteFileTool({}, { paths: [TMP_GRANTED] });
    const ctx = makeCtx(
      sessionWith([{ path: TMP_TRUSTED, access: "write" }]),
    );
    const result = await tool.execute(
      {
        path: path.join(TMP_TRUSTED, "new.txt"),
        content: "hello",
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const written = await fs.readFile(
      path.join(TMP_TRUSTED, "new.txt"),
      "utf8",
    );
    expect(written).toBe("hello");
  });

  it("read-write trusted paths also permit writes", async () => {
    const tool = new WriteFileTool({}, { paths: [TMP_GRANTED] });
    const ctx = makeCtx(
      sessionWith([{ path: TMP_TRUSTED, access: "read-write" }]),
    );
    const result = await tool.execute(
      {
        path: path.join(TMP_TRUSTED, "rw.txt"),
        content: "hello",
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });
});

describe("find honours session.trustedPaths()", () => {
  it("allows listing inside a trusted directory", async () => {
    const tool = new FindTool({}, { paths: [TMP_GRANTED] });
    const ctx = makeCtx(
      sessionWith([{ path: TMP_TRUSTED, access: "read" }]),
    );
    const result = await tool.execute(
      { pattern: "*.md", root: TMP_TRUSTED },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("skill.md");
  });

  it("rejects roots outside both the grant and trusted set", async () => {
    const tool = new FindTool({}, { paths: [TMP_GRANTED] });
    const ctx = makeCtx(
      sessionWith([{ path: TMP_TRUSTED, access: "read" }]),
    );
    const result = await tool.execute(
      { pattern: "*", root: TMP_FORBIDDEN },
      ctx,
    );
    expect(result.isError).toBe(true);
  });
});
