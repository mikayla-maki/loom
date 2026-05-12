/**
 * Bash bwrap integration tests (Linux).
 *
 * Mirror of bash-sandbox-integration.test.ts but for the Linux side.
 * Skipped silently on non-Linux or when /usr/bin/bwrap is missing.
 *
 * These tests actually spawn `/bin/bash` under `bwrap` and assert
 * the result. They're the only way to catch profile-generation bugs
 * that the unit-level tests can't see (mount-table layout issues,
 * baseline ro-bind set being too tight, network unsharing, etc.).
 *
 * Status: SKETCH. Mirrors the cwd-grant + denials + paths='*' suites
 * from the macOS side. Likely needs adjustment when first run on a
 * real Linux box — bwrap error messages differ and some assertions
 * will tighten or loosen.
 */

import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { BashTool } from "../src/runtime/builtins/bash.js";
import { hasBwrap } from "../src/runtime/sandbox/bwrap.js";
import type {
  Agent,
  ToolContext,
  ToolResult,
} from "../src/types/interfaces.js";
import type { CapabilitySet } from "../src/types/manifest.js";

let SUPPORTED = false;
beforeAll(async () => {
  SUPPORTED = process.platform === "linux" && (await hasBwrap());
});

const dit = (name: string, fn: () => void | Promise<void>): void => {
  it(name, async () => {
    if (!SUPPORTED) return; // silent skip on non-Linux / no-bwrap
    await fn();
  });
};

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
    // Deny every permission request (no handler matches the option list).
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
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

describe("bwrap: cwd-relative grant", () => {
  let scratch: string;
  beforeAll(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "loom-bwrap-cwd-"));
    await fs.writeFile(path.join(scratch, "hello.txt"), "world\n", "utf8");
    await fs.writeFile(
      path.join(scratch, "package.json"),
      '{"name": "test"}\n',
      "utf8",
    );
  });

  const grant = (root: string): CapabilitySet => ({
    subprocess: "*",
    paths: [root],
  });

  dit("pwd succeeds in granted cwd", async () => {
    const r = await runBash(grant(scratch), "pwd", scratch);
    expect(r.isError).toBeFalsy();
    expect(r.content.trim()).toBe(await fs.realpath(scratch));
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

  dit("system binaries (uname, date) work", async () => {
    const r = await runBash(grant(scratch), "uname -s && date +%Y", scratch);
    expect(r.isError).toBeFalsy();
    const lines = r.content.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // On Linux, uname -s prints "Linux"
    expect(lines[0]).toBe("Linux");
  });
});

describe("bwrap: denials", () => {
  let scratch: string;
  beforeAll(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "loom-bwrap-deny-"));
  });
  const grant = (root: string): CapabilitySet => ({
    subprocess: "*",
    paths: [root],
  });

  dit("reading a path NOT bind-mounted into the namespace fails", async () => {
    // The bwrap mount table includes /etc as ro-bind, so /etc/passwd
    // would actually be readable. Use $HOME which is NOT bound.
    const r = await runBash(
      grant(scratch),
      `cat "$HOME/.bashrc" 2>&1 || true`,
      scratch,
    );
    // Inside the bwrap namespace, $HOME doesn't even exist as a path,
    // so cat sees "No such file or directory".
    expect(r.content).toMatch(/No such file|Operation not permitted/);
  });

  dit("writing outside grant fails", async () => {
    // /etc is bind-mounted ro; writes should fail.
    const r = await runBash(
      grant(scratch),
      `echo nope > /etc/loom-bwrap-test 2>&1; echo "exit:$?"`,
      scratch,
    );
    expect(r.content).toMatch(/exit:[1-9]/);
    // And confirm nothing was created.
    let exists = true;
    try {
      await fs.access("/etc/loom-bwrap-test");
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  dit("network is denied when not granted", async () => {
    const r = await runBash(
      grant(scratch),
      `curl --max-time 1 -s https://example.com 2>&1; echo "exit:$?"`,
      scratch,
    );
    expect(r.content).toMatch(/exit:[1-9]/);
    expect(r.content).not.toMatch(/exit:0/);
  });
});

describe("bwrap: paths = star (whole FS)", () => {
  dit("can read /etc/hostname when paths = '*'", async () => {
    const r = await runBash(
      { subprocess: "*", paths: "*" },
      "cat /etc/hostname | head -1",
    );
    expect(r.isError).toBeFalsy();
    expect(r.content.length).toBeGreaterThan(0);
  });
});

describe("bwrap: scripting language interpreters", () => {
  let scratch: string;
  beforeAll(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "loom-bwrap-lang-"));
  });
  const grant = (root: string): CapabilitySet => ({
    subprocess: "*",
    paths: [root],
  });

  dit("python3 runs (when installed)", async () => {
    const r = await runBash(
      grant(scratch),
      `command -v python3 >/dev/null && python3 -c 'print("hello")' || echo missing`,
      scratch,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content.trim()).toMatch(/^hello$|^missing$/);
  });

  dit("perl -e works (when installed)", async () => {
    const r = await runBash(
      grant(scratch),
      `command -v perl >/dev/null && perl -e 'print "hello\\n"' || echo missing`,
      scratch,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content.trim()).toMatch(/^hello$|^missing$/);
  });
});

describe("bwrap: git", () => {
  let scratch: string;
  beforeAll(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "loom-bwrap-git-"));
  });
  const grant = (root: string): CapabilitySet => ({
    subprocess: "*",
    paths: [root],
  });

  dit("git --version runs without config errors", async () => {
    const r = await runBash(grant(scratch), "git --version", scratch);
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/git version/);
    expect(r.content).not.toMatch(/Operation not permitted/);
  });

  dit("git init + commit roundtrip works inside the granted dir", async () => {
    const repo = path.join(scratch, "repo");
    await fs.mkdir(repo, { recursive: true });
    const r = await runBash(
      grant(scratch),
      [
        "git init -q",
        "echo hi > a.txt",
        "git add a.txt",
        "git -c user.name=test -c user.email=test@example.com commit -q -m init",
        "git log --oneline",
      ].join(" && "),
      repo,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/init/);
  });
});
