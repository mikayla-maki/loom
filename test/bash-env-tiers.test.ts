/**
 * Unit coverage for the bash tool's two-tier env model:
 *   - Tier 1 (ALWAYS_INHERITED_ENV) — locale, terminal, identity.
 *     Always present in the child env regardless of grant.
 *   - Tier 2 (DEFAULT_INHERITED_ENV) — PATH, PWD, TMPDIR, editor vars.
 *     Default-on when `env` is absent; dropped when `env` is an
 *     explicit list.
 *
 * The contract these tests pin: writing `env = [...]` no longer
 * accidentally strips terminal sanity (Tier 1). That was the jank
 * we replaced.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  buildEnv,
  ALWAYS_INHERITED_ENV,
  DEFAULT_INHERITED_ENV,
} from "../src/runtime/builtins/bash.js";

/** Seed `process.env` with predictable values for each test. */
const SEED: Record<string, string> = {
  // Tier 1 — identity / terminal / locale.
  HOME: "/home/tester",
  USER: "tester",
  LOGNAME: "tester",
  SHELL: "/bin/zsh",
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  LC_CTYPE: "en_US.UTF-8",
  TZ: "America/Los_Angeles",
  // Tier 2 — PATH / PWD / TMPDIR / editor.
  PATH: "/usr/local/bin:/usr/bin:/bin",
  PWD: "/home/tester/projects/loom",
  TMPDIR: "/tmp",
  EDITOR: "nvim",
  VISUAL: "nvim",
  PAGER: "less",
  // Custom (neither tier) — credentials, app-specific, prefix-matchable.
  AWS_ACCESS_KEY_ID: "AKIA-fake",
  AWS_SECRET_ACCESS_KEY: "wOlfgang",
  GITHUB_TOKEN: "ghp_fake",
  CUSTOM_FLAG: "yes",
};

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Clear any inherited values that might conflict, then seed.
  for (const k of Object.keys(SEED)) delete process.env[k];
  Object.assign(process.env, SEED);
});

afterEach(() => {
  // Restore — vitest workers reuse process state across files.
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe("bash buildEnv — tier semantics", () => {
  it("whole-tool '*' passes through process.env unfiltered", () => {
    const env = buildEnv("*");
    // Sanity: every Tier 1 + Tier 2 + custom var is present.
    expect(env.HOME).toBe("/home/tester");
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("wOlfgang");
    expect(env.GITHUB_TOKEN).toBe("ghp_fake");
  });

  it("env = '*' (per-kind) passes through process.env unfiltered", () => {
    const env = buildEnv({ env: "*" });
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("wOlfgang");
    expect(env.CUSTOM_FLAG).toBe("yes");
  });

  it("env absent returns Tier 1 + Tier 2; no credentials, no app vars", () => {
    const env = buildEnv({});
    // Every Tier 1 name present.
    for (const name of ALWAYS_INHERITED_ENV) {
      expect(env[name]).toBe(SEED[name]);
    }
    // Every Tier 2 name present.
    for (const name of DEFAULT_INHERITED_ENV) {
      expect(env[name]).toBe(SEED[name]);
    }
    // Credentials + custom vars absent.
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.CUSTOM_FLAG).toBeUndefined();
  });

  it("env = [] keeps Tier 1 (hermetic-but-functional) and drops Tier 2", () => {
    // This is the load-bearing change: previously env = [] returned
    // an empty {}, which broke locale/terminal in every spawned bash.
    const env = buildEnv({ env: [] });
    for (const name of ALWAYS_INHERITED_ENV) {
      expect(env[name]).toBe(SEED[name]);
    }
    // Tier 2 stripped — including PATH. Hermetic users opting in.
    for (const name of DEFAULT_INHERITED_ENV) {
      expect(env[name]).toBeUndefined();
    }
  });

  it("env = ['NAME'] yields Tier 1 + NAME (not just NAME)", () => {
    // Previously this stripped Tier 1; now Tier 1 always wins.
    const env = buildEnv({ env: ["GITHUB_TOKEN"] });
    // Tier 1 still present.
    expect(env.HOME).toBe("/home/tester");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TZ).toBe("America/Los_Angeles");
    // Requested name present.
    expect(env.GITHUB_TOKEN).toBe("ghp_fake");
    // Tier 2 names NOT carried in (env list replaces Tier 2 defaults).
    expect(env.PATH).toBeUndefined();
    expect(env.EDITOR).toBeUndefined();
    // Other unrequested names absent.
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
  });

  it("env = ['PATH'] re-inherits PATH on top of Tier 1", () => {
    const env = buildEnv({ env: ["PATH"] });
    expect(env.HOME).toBe("/home/tester"); // Tier 1
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    // Other Tier 2 names dropped because env was explicit.
    expect(env.EDITOR).toBeUndefined();
    expect(env.PWD).toBeUndefined();
  });

  it("env = ['AWS_*'] prefix-matches and still carries Tier 1", () => {
    const env = buildEnv({ env: ["AWS_*"] });
    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIA-fake");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("wOlfgang");
    // Tier 1 unchanged.
    expect(env.HOME).toBe("/home/tester");
    expect(env.LC_CTYPE).toBe("en_US.UTF-8");
    // Non-matching custom var absent.
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.CUSTOM_FLAG).toBeUndefined();
  });

  it("env = ['PATH', 'AWS_*'] mixes exact + prefix on top of Tier 1", () => {
    const env = buildEnv({ env: ["PATH", "AWS_*"] });
    expect(env.PATH).toBeDefined();
    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIA-fake");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("wOlfgang");
    expect(env.HOME).toBe("/home/tester"); // Tier 1
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("Tier 1 vars listed explicitly in env are no-ops (already inherited)", () => {
    // Asking for HOME explicitly should not double-include or break.
    const env = buildEnv({ env: ["HOME", "GITHUB_TOKEN"] });
    expect(env.HOME).toBe("/home/tester");
    expect(env.GITHUB_TOKEN).toBe("ghp_fake");
  });

  it("missing-from-process.env names are silently skipped", () => {
    delete process.env.GITHUB_TOKEN;
    const env = buildEnv({ env: ["GITHUB_TOKEN", "DOES_NOT_EXIST"] });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.DOES_NOT_EXIST).toBeUndefined();
    // Tier 1 still flows.
    expect(env.HOME).toBe("/home/tester");
  });

  it("Tier 1 always survives even when process.env is partially cleared", () => {
    // Some shells launch with sparse env; the tool should still work.
    delete process.env.COLORTERM;
    delete process.env.LC_ALL;
    const env = buildEnv({});
    // Cleared names absent (we don't synthesize values).
    expect(env.COLORTERM).toBeUndefined();
    expect(env.LC_ALL).toBeUndefined();
    // Remaining Tier 1 still present.
    expect(env.HOME).toBe("/home/tester");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TERM).toBe("xterm-256color");
  });
});
