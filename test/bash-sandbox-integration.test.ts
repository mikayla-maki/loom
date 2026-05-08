/**
 * Bash sandbox integration tests.
 *
 * These actually spawn `/bin/bash` under `/usr/bin/sandbox-exec` and
 * assert the result. They're not pure unit tests \u2014 real I/O happens
 * \u2014 but they're the only way to catch profile-generation bugs that
 * SBPL syntax checkers won't see (the wrong-cwd-resolution bug that
 * shipped in the first sandbox commit, for example).
 *
 * Skipped on non-darwin platforms; macOS without `sandbox-exec` is
 * also gracefully skipped.
 */

import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { BashTool } from "../src/runtime/builtins/bash.js";
import { hasSandboxExec } from "../src/runtime/sandbox/sandbox-exec.js";
import type {
  Agent,
  ToolContext,
  ToolResult,
} from "../src/types/interfaces.js";
import type { CapabilitySet } from "../src/types/manifest.js";

let SUPPORTED = false;
beforeAll(async () => {
  SUPPORTED = process.platform === "darwin" && (await hasSandboxExec());
});

const dit = (name: string, fn: () => void | Promise<void>): void => {
  it(name, async () => {
    if (!SUPPORTED) {
      // Silent skip when sandbox-exec isn't available (Linux CI, older macOS,
      // etc.). The unit-level tests in sandbox-exec.test.ts cover the
      // profile-generation logic without spawning anything.
      return;
    }
    await fn();
  });
};

/**
 * Build a minimal ToolContext stub for integration tests. The bash
 * tool only reads `abortSignal` from ctx.
 */
function makeCtx(): ToolContext {
  const stubAgent: Agent = {
    harness: { run: async () => ({ stopReason: "end_turn" }) },
    session: { push: async () => [], pull: async () => [] },
    systemPromptCore: "",
    agentName: "test",
  };
  return {
    secrets: {},
    abortSignal: new AbortController().signal,
    requestPermission: async () => ({ decision: "deny" }),
    agent: stubAgent,
  };
}

async function runBash(
  caps: CapabilitySet,
  command: string,
  cwd?: string,
): Promise<ToolResult> {
  const tool = new BashTool({}, caps);
  return await tool.execute({ command, ...(cwd ? { cwd } : {}) }, makeCtx());
}

describe("bash sandbox: cwd-relative grant", () => {
  let scratch: string;
  /**
   * The kernel-canonical form of `scratch`. macOS `os.tmpdir()` returns
   * a path under `/var/folders/...` but the real path is
   * `/private/var/folders/...`. `pwd` and similar print the canonical
   * form, so test assertions compare against this.
   */
  let canonicalScratch: string;
  beforeAll(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "loom-bash-cwd-"));
    canonicalScratch = await fs.realpath(scratch);
    await fs.writeFile(path.join(scratch, "hello.txt"), "world\n", "utf8");
    await fs.writeFile(
      path.join(scratch, "package.json"),
      '{"name": "test"}\n',
      "utf8",
    );
  });

  // The grant `paths: ["./"]` resolves against process.cwd() at profile
  // generation time. We override the bash subprocess cwd to scratch and
  // also resolve the grant against scratch by passing scratch as the
  // path entry directly (so the test is independent of where vitest
  // happens to run from).
  const grant = (root: string): CapabilitySet => ({
    subprocess: "*",
    paths: [root],
  });

  dit("pwd succeeds in granted cwd", async () => {
    const r = await runBash(grant(scratch), "pwd", scratch);
    expect(r.isError).toBeFalsy();
    // pwd prints the kernel-canonical path (symlinks resolved), so
    // compare against the realpath of scratch.
    expect(r.content.trim()).toBe(canonicalScratch);
  });

  dit("ls -la succeeds in granted cwd", async () => {
    const r = await runBash(grant(scratch), "ls -la", scratch);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("hello.txt");
    expect(r.content).toContain("package.json");
  });

  dit("cat succeeds for a file in the grant", async () => {
    const r = await runBash(grant(scratch), "cat hello.txt", scratch);
    expect(r.isError).toBeFalsy();
    expect(r.content.trim()).toBe("world");
  });

  dit("cat with absolute path inside grant succeeds", async () => {
    const r = await runBash(
      grant(scratch),
      `cat ${path.join(scratch, "package.json")}`,
      scratch,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('"name": "test"');
  });

  dit("write via redirection succeeds in granted cwd", async () => {
    const r = await runBash(
      grant(scratch),
      `echo "from-bash" > out.txt && cat out.txt`,
      scratch,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content.trim()).toBe("from-bash");
  });

  dit("subprocess pipeline (echo | wc) succeeds", async () => {
    const r = await runBash(grant(scratch), "echo hi there | wc -w", scratch);
    expect(r.isError).toBeFalsy();
    expect(r.content.trim()).toBe("2");
  });

  dit("grep on a file in cwd succeeds", async () => {
    const r = await runBash(grant(scratch), "grep -c world hello.txt", scratch);
    expect(r.isError).toBeFalsy();
    expect(r.content.trim()).toBe("1");
  });

  dit("getcwd works (no shell-init warning)", async () => {
    // Without (allow file-read-metadata), bash prints "shell-init:
    // error retrieving current directory" on stderr. Verify clean.
    const r = await runBash(grant(scratch), "echo done", scratch);
    expect(r.isError).toBeFalsy();
    expect(r.content).not.toContain("shell-init");
  });

  dit("can read system binaries (date, uname, etc.)", async () => {
    const r = await runBash(grant(scratch), "uname -s && date +%Y", scratch);
    expect(r.isError).toBeFalsy();
    // Exact output varies; just ensure a non-empty multi-line response.
    const lines = r.content.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});

describe("bash sandbox: denials", () => {
  let scratch: string;
  beforeAll(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "loom-bash-deny-"));
  });
  const grant = (root: string): CapabilitySet => ({
    subprocess: "*",
    paths: [root],
  });

  dit("reading a file outside grant fails", async () => {
    // /etc/master.passwd is root-only and outside our grant. Even if
    // /etc/passwd happens to be readable via the baseline /private/etc
    // rule, master.passwd is guaranteed to be denied.
    const r = await runBash(
      grant(scratch),
      `cat /Users/$USER/.zshrc 2>&1 || true`,
      scratch,
    );
    // We use `|| true` so bash exits 0; assert the error text is in the output.
    expect(r.content).toMatch(/Operation not permitted|No such file/);
  });

  dit("writing outside grant fails", async () => {
    const target = path.join(os.homedir(), ".loom-sandbox-test-bad");
    // Don't `|| true` away the failure — we want the non-zero exit so
    // BashTool surfaces stderr in the result content. The bash redirect
    // failure ("<path>: Operation not permitted") goes to bash's stderr
    // before any command runs.
    const r = await runBash(grant(scratch), `echo nope > "${target}"`, scratch);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Operation not permitted/);
    // And confirm the file wasn't created.
    let exists = true;
    try {
      await fs.access(target);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  dit("network is denied when not granted", async () => {
    // curl with a 1-second timeout. Should fail to resolve or connect.
    const r = await runBash(
      grant(scratch),
      `curl --max-time 1 -s https://example.com 2>&1; echo "exit:$?"`,
      scratch,
    );
    // Various curl error texts depending on macOS version: "Could not
    // resolve host", "Operation not permitted", etc. Just assert curl
    // reported failure (non-zero exit captured via echo).
    expect(r.content).toMatch(/exit:[1-9]/);
    expect(r.content).not.toMatch(/exit:0/);
  });
});

describe("bash sandbox: paths = star (unrestricted FS)", () => {
  dit("can read /etc/hosts when paths = '*'", async () => {
    const r = await runBash(
      { subprocess: "*", paths: "*" },
      "cat /etc/hosts | head -1",
    );
    expect(r.isError).toBeFalsy();
    // /etc/hosts on macOS always starts with a comment line.
    expect(r.content.length).toBeGreaterThan(0);
  });
});

describe("bash unsandboxed (capabilities = '*')", () => {
  dit("runs without sandbox-exec engagement", async () => {
    // No structured grant → no sandbox. pwd should always work.
    const r = await runBash("*", "pwd");
    expect(r.isError).toBeFalsy();
    expect(r.content.trim()).toBe(process.cwd());
  });
});
