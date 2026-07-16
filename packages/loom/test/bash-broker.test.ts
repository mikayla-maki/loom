import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { textContent } from "./helpers/assert.js";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  encodeFrame,
  FrameDecoder,
  CH_REQUEST,
  CH_STDOUT,
  CH_EXIT,
} from "../src/runtime/sandbox/broker.js";
import { BashTool } from "../src/runtime/builtins/bash.js";
import { hasSandboxExec } from "../src/runtime/sandbox/sandbox-exec.js";
import { hasBwrap } from "../src/runtime/sandbox/bwrap.js";
import type {
  Agent,
  ToolContext,
  ToolResult,
} from "../src/types/interfaces.js";
import type { CapabilityGrant } from "../src/types/manifest.js";

describe("broker wire protocol", () => {
  it("round-trips a single frame", () => {
    const payload = Buffer.from("hello", "utf8");
    const decoder = new FrameDecoder();
    const frames = decoder.push(encodeFrame(CH_STDOUT, payload));
    expect(frames).toEqual([{ channel: CH_STDOUT, payload }]);
  });

  it("decodes multiple frames from one chunk", () => {
    const a = encodeFrame(CH_REQUEST, Buffer.from("req"));
    const b = encodeFrame(CH_STDOUT, Buffer.from("out"));
    const decoder = new FrameDecoder();
    const frames = decoder.push(Buffer.concat([a, b]));
    expect(frames.map((f) => f.channel)).toEqual([CH_REQUEST, CH_STDOUT]);
    expect(frames.map((f) => f.payload.toString())).toEqual(["req", "out"]);
  });

  it("reassembles a frame split across chunks", () => {
    const full = encodeFrame(CH_STDOUT, Buffer.from("split"));
    const decoder = new FrameDecoder();
    expect(decoder.push(full.subarray(0, 3))).toEqual([]);
    expect(decoder.push(full.subarray(3))).toEqual([
      { channel: CH_STDOUT, payload: Buffer.from("split") },
    ]);
  });

  it("handles an empty payload", () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(encodeFrame(CH_STDOUT, Buffer.alloc(0)));
    expect(frames).toEqual([{ channel: CH_STDOUT, payload: Buffer.alloc(0) }]);
  });

  it("carries an int32 exit code", () => {
    const payload = Buffer.alloc(4);
    payload.writeInt32BE(42, 0);
    const decoder = new FrameDecoder();
    const frames = decoder.push(encodeFrame(CH_EXIT, payload));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.channel).toBe(CH_EXIT);
    expect(frames[0]!.payload.readInt32BE(0)).toBe(42);
  });
});

function makeCtx(): ToolContext {
  const stubAgent: Agent = {
    manifest: { name: "test", harness: { provider: "test" } },
    harness: { run: async () => ({ stopReason: "end_turn" }) },
    session: { push: async () => [], pull: async () => [] },
    systemPromptCore: "",
  };
  return {
    secrets: {},
    abortSignal: new AbortController().signal,
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    agent: stubAgent,
  };
}

describe("bash broker: per-command rows reach pipelines", () => {
  let supported = false;
  let hasPython = false;
  let scratch = "";
  let work = "";
  let secret = "";

  beforeAll(async () => {
    supported =
      (process.platform === "darwin" && (await hasSandboxExec())) ||
      (process.platform === "linux" && (await hasBwrap()));
    hasPython = spawnSync("python3", ["--version"]).status === 0;
    if (!supported) return;
    // Home, not os.tmpdir(): the sandbox baseline allows reading
    // /private/var/folders (macOS tmpdir), which would defeat the
    // negative cases below. $HOME is not baseline-readable.
    scratch = await fs.mkdtemp(path.join(os.homedir(), "loom-broker-"));
    work = path.join(scratch, "work");
    secret = path.join(scratch, "secret");
    await fs.mkdir(work);
    await fs.mkdir(secret);
    await fs.writeFile(path.join(secret, "s.txt"), "hello-from-the-row\n");
  });

  afterAll(async () => {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  });

  const dit = (name: string, fn: () => Promise<void>): void => {
    it(name, async (ctx) => {
      if (!supported) ctx.skip();
      await fn();
    });
  };

  // General row may only touch `work`; a `cat` row additionally reaches
  // `secret`. The broker lets `cat` carry that wider grant even inside a
  // pipeline the general shell runs under the narrower one. Built per call
  // because `work`/`secret` are only assigned in beforeAll.
  const run = async (command: string): Promise<ToolResult> => {
    const rows: CapabilityGrant[] = [
      { commands: "*", paths: [work] },
      { commands: ["cat"], paths: [work, secret] },
    ];
    const tool = new BashTool({}, rows);
    return await tool.execute({ command, cwd: work }, makeCtx());
  };

  dit("brokered cat reads its row's path inside a pipe", async () => {
    const r = await run(`cat ${secret}/s.txt | tr a-z A-Z`);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("HELLO-FROM-THE-ROW");
  });

  dit("brokered cat promotes a bare invocation", async () => {
    const r = await run(`cat ${secret}/s.txt`);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("hello-from-the-row");
  });

  dit("the general shell cannot read the cat-only path", async () => {
    const r = await run(`tr a-z A-Z < ${secret}/s.txt`);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Operation not permitted|No such file/);
  });

  dit("a non-rowed command stays dark in a pipe", async () => {
    const r = await run(`head -c5 ${secret}/s.txt | cat`);
    expect(r.content).not.toContain("hello");
  });

  // The broker should run the child as close to an in-process invocation as
  // possible: in the shell's working directory, following any `cd`. A
  // relative path resolves only if the brokered `cat` runs in the right dir
  // — and `cat` is an external binary, so unlike `pwd` it truly round-trips
  // through the broker.
  dit("a brokered command resolves a relative path in the cwd", async () => {
    await fs.mkdir(path.join(work, "sub"), { recursive: true });
    await fs.writeFile(path.join(work, "sub", "note.txt"), "in-the-cwd\n");
    const r = await run(`cat sub/note.txt | tr a-z A-Z`);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("IN-THE-CWD");
  });

  dit("a brokered command follows a cd into a subdirectory", async () => {
    await fs.mkdir(path.join(work, "deep"), { recursive: true });
    await fs.writeFile(path.join(work, "deep", "note.txt"), "after-cd\n");
    const r = await run(`cd deep && cat note.txt | tr a-z A-Z`);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("AFTER-CD");
  });

  // The shim reads its own cwd (getcwd) to forward it; the sandbox must allow
  // that for the granted directory. /bin/pwd issues the real getcwd syscall,
  // unlike the bash builtin which just echoes PWD.
  dit("the sandbox allows getcwd in the granted directory", async () => {
    const r = await run(`/bin/pwd`);
    expect(r.isError).toBeFalsy();
    expect(textContent(r.content).trim()).toBe(await fs.realpath(work));
  });

  dit("a brokered command can read its own cwd via getcwd", async () => {
    const rows: CapabilityGrant[] = [
      { commands: "*", paths: [work] },
      { commands: ["pwd"], paths: [work] },
    ];
    const tool = new BashTool({}, rows);
    // `env pwd` resolves `pwd` through PATH — the broker shim — so /bin/pwd
    // runs under the pwd row and must getcwd successfully inside the broker.
    const r = await tool.execute({ command: "env pwd", cwd: work }, makeCtx());
    expect(r.isError).toBeFalsy();
    expect(textContent(r.content).trim()).toBe(await fs.realpath(work));
  });

  // Exit-status fidelity: a brokered command's exit code must reach the
  // shell so `$?` and `set -o pipefail` work as if it ran in-process.
  dit("a brokered command's non-zero exit propagates", async () => {
    const r = await run(`cat /no/such/file; echo "rc=$?"`);
    expect(r.content).toMatch(/rc=[1-9]/);
  });

  // A signal death must surface as a failure, not exit 0. The brokered `sh`
  // (spawned by the broker as a host-side child) kills itself; the broker
  // must relay that as 128+signum so the outer shell sees the failure.
  dit("a brokered command killed by a signal reports failure", async () => {
    const rows: CapabilityGrant[] = [
      { commands: "*", paths: [work] },
      { commands: ["sh"], paths: [work] },
    ];
    const tool = new BashTool({}, rows);
    const r = await tool.execute(
      { command: `sh -c 'kill -KILL $$'; echo "rc=$?"`, cwd: work },
      makeCtx(),
    );
    expect(r.content).toMatch(/rc=137/);
  });

  // SECURITY: an agent can plant a binary named after a rowed command in a
  // writable dir and insert it on PATH after the shim. The broker must
  // resolve the command against the HOST PATH, so the real binary runs under
  // the row's grant — never the agent's substitute.
  dit(
    "the broker resolves a rowed command to the host binary, not a planted one",
    async () => {
      const rows: CapabilityGrant[] = [
        { commands: "*", paths: [work] },
        { commands: ["cat"], paths: [work] },
      ];
      const tool = new BashTool({}, rows);
      const fakeDir = path.join(work, "fakebin");
      await fs.mkdir(fakeDir, { recursive: true });
      await fs.writeFile(
        path.join(fakeDir, "cat"),
        "#!/bin/sh\necho PLANTED\n",
        {
          mode: 0o755,
        },
      );
      await fs.writeFile(path.join(work, "real.txt"), "genuine\n");
      // Keep the shim dir (PATH's first entry) first so the shim is still hit,
      // but slip the planted dir in right after it.
      const cmd =
        `first=\${PATH%%:*}; rest=\${PATH#*:}; ` +
        `export PATH="$first:${fakeDir}:$rest"; cat real.txt`;
      const r = await tool.execute({ command: cmd, cwd: work }, makeCtx());
      expect(r.isError).toBeFalsy();
      expect(r.content).toContain("genuine");
      expect(r.content).not.toContain("PLANTED");
    },
  );

  // The full Matryoshka: a sandboxed shell runs python, which chdir's and
  // spawns a second python, which chdir's deeper and invokes the brokered
  // `cat`. The broker must run `cat` in the *innermost* process's working
  // directory — proving the cwd is read at the point of invocation (sent
  // over the wire by the shim), not assumed from the top-level shell.
  dit("brokered command runs in the deepest nested cwd", async () => {
    if (!hasPython) return;
    const deep = path.join(work, "m1", "m2");
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(deep, "treasure.txt"), "matryoshka-deep\n");

    const innerPy = path.join(work, "inner.py");
    await fs.writeFile(
      innerPy,
      [
        "import os, subprocess",
        "os.chdir('m2')", // now in work/m1/m2
        "subprocess.run(['cat', 'treasure.txt'])", // brokered, relative path
      ].join("\n") + "\n",
    );
    await fs.writeFile(
      path.join(work, "outer.py"),
      [
        "import os, subprocess, sys",
        "os.chdir('m1')", // now in work/m1
        `subprocess.run([sys.executable, ${JSON.stringify(innerPy)}], check=True)`,
      ].join("\n") + "\n",
    );

    const r = await run("python3 outer.py");
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("matryoshka-deep");
  });
});
