/**
 * Shared driver for the bash-tool sandbox integration suites.
 *
 * Both backends (macOS `sandbox-exec`, Linux `bwrap`) need to exercise
 * the same surface area: cwd-relative grants succeed, paths outside
 * the grant are denied, network is denied unless granted, etc. The
 * differences are exactly:
 *   - which platform engages the backend,
 *   - the error text on a denied write/read,
 *   - the canonicalisation rules (macOS `pwd` resolves /var → /private/var).
 *
 * This module exposes one `describeBashIntegration(backend)` entry
 * point that wires up the common suites against a backend-specific
 * support gate. Each per-backend test file is then a 10-line shim
 * that imports this helper and adds any backend-only extras.
 */

import { describe, it, beforeAll, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { BashTool } from "../../src/runtime/builtins/bash.js";
import type {
  Agent,
  ToolContext,
  ToolResult,
} from "../../src/types/interfaces.js";
import type { CapabilitySet } from "../../src/types/manifest.js";

export interface BashBackend {
  /** Display name, e.g. "sandbox-exec" or "bwrap". */
  readonly name: string;
  /** Resolves to true when the backend is available on this host. */
  isSupported(): Promise<boolean>;
  /** Expected `uname -s` output (e.g. "Darwin", "Linux"); used by one assertion. */
  readonly unameMatches?: RegExp;
  /**
   * Backend-specific denied-read assertion: what bash produces when
   * trying to read a file outside the grant. `sandbox-exec` produces
   * "Operation not permitted"; `bwrap` produces "No such file or
   * directory" because the path isn't bind-mounted at all.
   */
  readonly deniedReadPattern: RegExp;
}

/** Build a minimal ToolContext stub. Bash only reads `abortSignal`. */
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

async function runBash(
  caps: CapabilitySet,
  command: string,
  cwd?: string,
): Promise<ToolResult> {
  const tool = new BashTool({}, caps);
  return await tool.execute({ command, ...(cwd ? { cwd } : {}) }, makeCtx());
}

const grantFor = (root: string): CapabilitySet => ({
  commands: "*",
  paths: [root],
});

/**
 * Registers the shared bash-integration suites against `backend`.
 * Call from inside the test file's top-level scope.
 */
export function describeBashIntegration(backend: BashBackend): void {
  let supported = false;
  beforeAll(async () => {
    supported = await backend.isSupported();
  });

  /** `it` variant that reports SKIPPED when the backend isn't available. */
  const dit = (name: string, fn: () => void | Promise<void>): void => {
    it(name, async (ctx) => {
      if (!supported) ctx.skip();
      await fn();
    });
  };

  // One scratch dir per describe, shared across its tests. Returns a
  // getter since the dir is allocated in beforeAll.
  const useScratch = (tag: string): (() => string) => {
    let scratch = "";
    beforeAll(async () => {
      scratch = await fs.mkdtemp(
        path.join(os.tmpdir(), `loom-${backend.name}-${tag}-`),
      );
    });
    return () => scratch;
  };

  describe(`${backend.name}: cwd-relative grant`, () => {
    let scratch: string;
    /** Kernel-canonical form (macOS `/var/folders/…` → `/private/var/…`). */
    let canonicalScratch: string;
    beforeAll(async () => {
      scratch = await fs.mkdtemp(
        path.join(os.tmpdir(), `loom-${backend.name}-cwd-`),
      );
      canonicalScratch = await fs.realpath(scratch);
      await fs.writeFile(path.join(scratch, "hello.txt"), "world\n", "utf8");
      await fs.writeFile(
        path.join(scratch, "package.json"),
        '{"name": "test"}\n',
        "utf8",
      );
    });

    dit("pwd reports the canonical granted cwd", async () => {
      const r = await runBash(grantFor(scratch), "pwd", scratch);
      expect(r.isError).toBeFalsy();
      expect(r.content.trim()).toBe(canonicalScratch);
    });

    dit("ls -la lists files in the grant", async () => {
      const r = await runBash(grantFor(scratch), "ls -la", scratch);
      expect(r.isError).toBeFalsy();
      expect(r.content).toContain("hello.txt");
      expect(r.content).toContain("package.json");
    });

    dit("cat reads a file in the grant", async () => {
      const r = await runBash(grantFor(scratch), "cat hello.txt", scratch);
      expect(r.isError).toBeFalsy();
      expect(r.content.trim()).toBe("world");
    });

    dit("write via redirection succeeds in the grant", async () => {
      const r = await runBash(
        grantFor(scratch),
        `echo "from-bash" > out.txt && cat out.txt`,
        scratch,
      );
      expect(r.isError).toBeFalsy();
      expect(r.content.trim()).toBe("from-bash");
    });

    dit("shell pipeline (echo | wc) works", async () => {
      const r = await runBash(
        grantFor(scratch),
        "echo hi there | wc -w",
        scratch,
      );
      expect(r.isError).toBeFalsy();
      expect(r.content.trim()).toBe("2");
    });

    dit("system binaries (uname, date) work", async () => {
      const r = await runBash(
        grantFor(scratch),
        "uname -s && date +%Y",
        scratch,
      );
      expect(r.isError).toBeFalsy();
      const lines = r.content.trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(2);
      if (backend.unameMatches) {
        expect(lines[0]).toMatch(backend.unameMatches);
      }
    });
  });

  describe(`${backend.name}: denials`, () => {
    const scratch = useScratch("deny");

    dit("reading a file outside the grant fails", async () => {
      // Use $HOME — neither backend bind-mounts/exposes it, so reads
      // fail with the backend's denial text.
      const r = await runBash(
        grantFor(scratch()),
        `cat "$HOME/.bashrc" 2>&1 || true`,
        scratch(),
      );
      expect(r.content).toMatch(backend.deniedReadPattern);
    });

    dit("network is denied when not granted", async () => {
      const r = await runBash(
        grantFor(scratch()),
        `curl --max-time 1 -s https://example.com 2>&1; echo "exit:$?"`,
        scratch(),
      );
      expect(r.content).toMatch(/exit:[1-9]/);
      expect(r.content).not.toMatch(/exit:0/);
    });
  });

  describe(`${backend.name}: scripting language interpreters`, () => {
    const scratch = useScratch("lang");

    dit("python3 -c works (when installed)", async () => {
      const r = await runBash(
        grantFor(scratch()),
        `command -v python3 >/dev/null && python3 -c 'print("hello python")' || echo missing`,
        scratch(),
      );
      expect(r.isError).toBeFalsy();
      expect(r.content.trim()).toMatch(/^hello python$|^missing$/);
    });

    dit("perl -e works (when installed)", async () => {
      const r = await runBash(
        grantFor(scratch()),
        `command -v perl >/dev/null && perl -e 'print "hello perl\\n"' || echo missing`,
        scratch(),
      );
      expect(r.isError).toBeFalsy();
      expect(r.content.trim()).toMatch(/^hello perl$|^missing$/);
    });
  });

  describe(`${backend.name}: git`, () => {
    // Git reads ~/.gitconfig at startup. Without that path in the
    // baseline, every git command fails with "unable to access …".
    // Regression guard for both backends' carve-outs.
    const scratch = useScratch("git");

    dit("git --version runs without config errors", async () => {
      const r = await runBash(grantFor(scratch()), "git --version", scratch());
      expect(r.isError).toBeFalsy();
      expect(r.content).toMatch(/git version/);
      expect(r.content).not.toMatch(/Operation not permitted/);
      expect(r.content).not.toMatch(/unable to access/);
    });

    dit(
      "git init + commit roundtrip works inside the granted dir",
      async () => {
        const repo = path.join(scratch(), "repo");
        await fs.mkdir(repo, { recursive: true });
        const r = await runBash(
          grantFor(scratch()),
          [
            "git init -q",
            "echo hi > a.txt",
            "git add a.txt",
            // -c user.* lets the test pass on CI machines without identity set.
            "git -c user.name=test -c user.email=test@example.com commit -q -m init",
            "git log --oneline",
          ].join(" && "),
          repo,
        );
        expect(r.isError).toBeFalsy();
        expect(r.content).toMatch(/init/);
      },
    );
  });

  describe(`${backend.name}: paths = star (unrestricted FS)`, () => {
    dit("can read a system file when paths = '*'", async () => {
      // Both /etc/hosts (darwin) and /etc/hostname (linux) exist and
      // have non-empty contents. Try whichever the host has.
      const r = await runBash(
        { commands: "*", paths: "*" },
        "cat /etc/hosts 2>/dev/null | head -1 || cat /etc/hostname | head -1",
      );
      expect(r.isError).toBeFalsy();
      expect(r.content.length).toBeGreaterThan(0);
    });
  });
}

// Re-exports used by the per-backend shim files for their own extras
// (e.g. the macOS-only "shell-init / getcwd" regression check).
export { runBash, makeCtx, grantFor };
