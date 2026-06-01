import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { hasSandboxExec } from "../src/runtime/sandbox/sandbox-exec.js";
import {
  describeBashIntegration,
  runBash,
  grantFor,
} from "./helpers/bash-integration.js";

describeBashIntegration({
  name: "sandbox-exec",
  isSupported: async () =>
    process.platform === "darwin" && (await hasSandboxExec()),
  // /etc is bind-readable, so reads of never-accessible paths surface as
  // "No such file" rather than EPERM.
  deniedReadPattern: /Operation not permitted|No such file/,
});

describe("sandbox-exec extras (macOS-only)", () => {
  let supported = false;
  let scratch = "";
  beforeAll(async () => {
    supported = process.platform === "darwin" && (await hasSandboxExec());
    if (supported) {
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "loom-bash-extra-"));
    }
  });
  const dit = (name: string, fn: () => void | Promise<void>): void => {
    it(name, async () => {
      if (!supported) return;
      await fn();
    });
  };

  dit("cat with absolute path inside grant succeeds", async () => {
    await fs.writeFile(
      path.join(scratch, "package.json"),
      '{"name": "test"}\n',
      "utf8",
    );
    const r = await runBash(
      grantFor(scratch),
      `cat ${path.join(scratch, "package.json")}`,
      scratch,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('"name": "test"');
  });

  dit("getcwd works (no shell-init warning)", async () => {
    const r = await runBash(grantFor(scratch), "echo done", scratch);
    expect(r.isError).toBeFalsy();
    expect(r.content).not.toContain("shell-init");
  });

  dit("writing outside grant fails", async () => {
    const target = path.join(os.homedir(), ".loom-sandbox-test-bad");
    const r = await runBash(
      grantFor(scratch),
      `echo nope > "${target}"`,
      scratch,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Operation not permitted/);
    let exists = true;
    try {
      await fs.access(target);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  dit("ruby -e works under sandbox (when installed)", async () => {
    const r = await runBash(
      grantFor(scratch),
      `command -v ruby >/dev/null && ruby -e 'puts "hello ruby"' || echo "missing"`,
      scratch,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content.trim()).toMatch(/^hello ruby$|^missing$/);
  });
});

describe("bash unsandboxed (capabilities = '*')", () => {
  it("runs without sandbox-exec engagement", async () => {
    const r = await runBash("*", "pwd");
    expect(r.isError).toBeFalsy();
    expect(r.content.trim()).toBe(process.cwd());
  });
});
