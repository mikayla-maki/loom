import { describe, expect, it } from "vitest";

import {
  buildBashProfile,
  sandboxEngaged,
  validateBashGrant,
} from "../src/runtime/sandbox/sandbox-exec.js";

describe("sandboxEngaged", () => {
  it("returns false for the whole-tool star grant (opt-out)", () => {
    expect(sandboxEngaged("*")).toBe(false);
  });

  it("returns true for any structured grant, even empty", () => {
    expect(sandboxEngaged({})).toBe(true);
    expect(sandboxEngaged({ subprocess: "*" })).toBe(true);
  });
});

describe("buildBashProfile", () => {
  it("throws when given a `*` grant (caller should have checked first)", () => {
    expect(() => buildBashProfile("*")).toThrow(/no sandbox/);
  });

  it("emits version + default-deny + bash-baseline rules", () => {
    const profile = buildBashProfile({});
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(allow process-fork)");
    expect(profile).toContain("(allow signal (target self))");
    // System library reads needed for bash to even load
    expect(profile).toContain('(allow file-read* (subpath "/usr"))');
    expect(profile).toContain('(allow file-read* (subpath "/System"))');
  });

  it("emits process-exec when subprocess is granted star", () => {
    const profile = buildBashProfile({ subprocess: "*" });
    expect(profile).toContain("(allow process-exec*)");
  });

  it("emits per-path subpath rules for path allowlists", () => {
    const profile = buildBashProfile({ paths: ["/proj", "/tmp/x"] });
    expect(profile).toContain('(allow file-read*  (subpath "/proj"))');
    expect(profile).toContain('(allow file-write* (subpath "/proj"))');
    expect(profile).toContain('(allow file-read*  (subpath "/tmp/x"))');
    expect(profile).toContain('(allow file-write* (subpath "/tmp/x"))');
  });

  it("emits unrestricted FS rules for paths = star", () => {
    const profile = buildBashProfile({ paths: "*" });
    expect(profile).toContain("(allow file-read*)");
    expect(profile).toContain("(allow file-write*)");
  });

  it("emits network rule only when network is granted star", () => {
    expect(buildBashProfile({ network: "*" })).toContain("(allow network*)");
    expect(buildBashProfile({})).not.toContain("(allow network*)");
    // Empty list = explicit deny; no rule emitted (default-deny covers it)
    expect(buildBashProfile({ network: [] })).not.toContain("(allow network*)");
  });

  it("escapes embedded quotes and backslashes in path strings", () => {
    const profile = buildBashProfile({ paths: ['/has"quote', "/has\\back"] });
    expect(profile).toContain('(subpath "/has\\"quote")');
    expect(profile).toContain('(subpath "/has\\\\back")');
  });

  it("composes the canonical default grant correctly", () => {
    // The DEFAULT_TOP_LEVEL_CAPABILITIES.bash shape — the practical
    // out-of-the-box config users will run with.
    const profile = buildBashProfile({ subprocess: "*", paths: ["./"] });
    expect(profile).toContain("(allow process-exec*)");
    expect(profile).toContain('(allow file-read*  (subpath "./"))');
    expect(profile).toContain('(allow file-write* (subpath "./"))');
    // No network rule means default-deny applies → no network access.
    expect(profile).not.toContain("(allow network*)");
  });

  it("includes the file-read root literal needed for cwd resolution", () => {
    // Without (allow file-read* (literal "/")) bash exits with SIGABRT
    // before running any user command. Regression guard.
    const profile = buildBashProfile({});
    expect(profile).toContain('(allow file-read* (literal "/"))');
  });
});

describe("validateBashGrant", () => {
  it("`*` whole-tool grant is exempt from validation", () => {
    expect(() => validateBashGrant("*")).not.toThrow();
  });

  it("empty `{}` grant is fine (default-deny everywhere)", () => {
    expect(() => validateBashGrant({})).not.toThrow();
  });

  it("accepts subprocess = '*' but rejects exec allowlists", () => {
    expect(() => validateBashGrant({ subprocess: "*" })).not.toThrow();
    expect(() => validateBashGrant({ subprocess: ["ls", "rg"] })).toThrow(
      /exec allowlist/,
    );
  });

  it("accepts paths = '*' or string array; rejects other shapes", () => {
    expect(() => validateBashGrant({ paths: "*" })).not.toThrow();
    expect(() => validateBashGrant({ paths: ["./", "/tmp"] })).not.toThrow();
    expect(() => validateBashGrant({ paths: [] })).not.toThrow();
    // Number is not a valid path value.
    expect(() => validateBashGrant({ paths: 42 } as unknown as never)).toThrow(
      /array of strings/,
    );
    // Mixed array with non-string is rejected.
    expect(() =>
      validateBashGrant({ paths: ["./", 42] } as unknown as never),
    ).toThrow(/array of strings/);
  });

  it("rejects network host allowlists (sandbox-exec can't filter by host)", () => {
    expect(() => validateBashGrant({ network: "*" })).not.toThrow();
    expect(() => validateBashGrant({ network: [] })).not.toThrow();
    expect(() => validateBashGrant({ network: ["example.com"] })).toThrow(
      /per-host/i,
    );
  });

  it("accepts env = '*' or string array; rejects other shapes", () => {
    expect(() => validateBashGrant({ env: "*" })).not.toThrow();
    expect(() => validateBashGrant({ env: ["PATH", "AWS_*"] })).not.toThrow();
    expect(() =>
      validateBashGrant({ env: { PATH: "/usr/bin" } } as unknown as never),
    ).toThrow(/array of strings/);
  });
});
