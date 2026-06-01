import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  buildEnv,
  ALWAYS_INHERITED_ENV,
  DEFAULT_INHERITED_ENV,
} from "../src/runtime/builtins/bash.js";
import type { CapabilitySet } from "../src/types/manifest.js";

const SEED: Record<string, string> = {
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
  PATH: "/usr/local/bin:/usr/bin:/bin",
  PWD: "/home/tester/projects/loom",
  TMPDIR: "/tmp",
  EDITOR: "nvim",
  VISUAL: "nvim",
  PAGER: "less",
  AWS_ACCESS_KEY_ID: "AKIA-fake",
  AWS_SECRET_ACCESS_KEY: "wOlfgang",
  GITHUB_TOKEN: "ghp_fake",
  CUSTOM_FLAG: "yes",
};

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const k of Object.keys(SEED)) delete process.env[k];
  Object.assign(process.env, SEED);
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe("bash buildEnv — tier semantics", () => {
  it("'*' passes through process.env unfiltered", () => {
    const grants: CapabilitySet[] = ["*", { env: "*" }];
    for (const grant of grants) {
      const env = buildEnv(grant);
      expect(env.HOME).toBe("/home/tester");
      expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(env.AWS_SECRET_ACCESS_KEY).toBe("wOlfgang");
      expect(env.GITHUB_TOKEN).toBe("ghp_fake");
      expect(env.CUSTOM_FLAG).toBe("yes");
    }
  });

  it("env absent returns Tier 1 + Tier 2; no credentials, no app vars", () => {
    const env = buildEnv({});
    for (const name of ALWAYS_INHERITED_ENV) expect(env[name]).toBe(SEED[name]);
    for (const name of DEFAULT_INHERITED_ENV) expect(env[name]).toBe(SEED[name]);
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.CUSTOM_FLAG).toBeUndefined();
  });

  it("env = [] keeps Tier 1 and drops Tier 2 (including PATH)", () => {
    const env = buildEnv({ env: [] });
    for (const name of ALWAYS_INHERITED_ENV) expect(env[name]).toBe(SEED[name]);
    for (const name of DEFAULT_INHERITED_ENV) expect(env[name]).toBeUndefined();
  });

  it("env list replaces Tier 2 defaults but never strips Tier 1", () => {
    const env = buildEnv({ env: ["GITHUB_TOKEN"] });
    expect(env.HOME).toBe("/home/tester");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TZ).toBe("America/Los_Angeles");
    expect(env.GITHUB_TOKEN).toBe("ghp_fake");
    expect(env.PATH).toBeUndefined();
    expect(env.EDITOR).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
  });

  it("env list can re-inherit a single Tier 2 var (PATH) on top of Tier 1", () => {
    const env = buildEnv({ env: ["PATH"] });
    expect(env.HOME).toBe("/home/tester");
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
    expect(env.EDITOR).toBeUndefined();
    expect(env.PWD).toBeUndefined();
  });

  it("env list supports prefix matching and mixed exact + prefix entries", () => {
    const prefixed = buildEnv({ env: ["AWS_*"] });
    expect(prefixed.AWS_ACCESS_KEY_ID).toBe("AKIA-fake");
    expect(prefixed.AWS_SECRET_ACCESS_KEY).toBe("wOlfgang");
    expect(prefixed.HOME).toBe("/home/tester");
    expect(prefixed.LC_CTYPE).toBe("en_US.UTF-8");
    expect(prefixed.GITHUB_TOKEN).toBeUndefined();
    expect(prefixed.CUSTOM_FLAG).toBeUndefined();

    const mixed = buildEnv({ env: ["PATH", "AWS_*"] });
    expect(mixed.PATH).toBeDefined();
    expect(mixed.AWS_ACCESS_KEY_ID).toBe("AKIA-fake");
    expect(mixed.AWS_SECRET_ACCESS_KEY).toBe("wOlfgang");
    expect(mixed.HOME).toBe("/home/tester");
    expect(mixed.GITHUB_TOKEN).toBeUndefined();
  });

  it("explicitly listing a Tier 1 var is a harmless no-op", () => {
    const env = buildEnv({ env: ["HOME", "GITHUB_TOKEN"] });
    expect(env.HOME).toBe("/home/tester");
    expect(env.GITHUB_TOKEN).toBe("ghp_fake");
  });

  it("names missing from process.env are silently skipped, Tier 1 still flows", () => {
    delete process.env.GITHUB_TOKEN;
    const env = buildEnv({ env: ["GITHUB_TOKEN", "DOES_NOT_EXIST"] });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.DOES_NOT_EXIST).toBeUndefined();
    expect(env.HOME).toBe("/home/tester");
  });

  it("Tier 1 vars absent from process.env are not synthesized", () => {
    delete process.env.COLORTERM;
    delete process.env.LC_ALL;
    const env = buildEnv({});
    expect(env.COLORTERM).toBeUndefined();
    expect(env.LC_ALL).toBeUndefined();
    expect(env.HOME).toBe("/home/tester");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TERM).toBe("xterm-256color");
  });
});
