import { describe, expect, it } from "vitest";

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

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
  it("throws when given a `*` grant (caller should have checked first)", async () => {
    await expect(buildBashProfile("*")).rejects.toThrow(/no sandbox/);
  });

  it("emits version + default-deny + bash-baseline rules", async () => {
    const profile = await buildBashProfile({});
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(allow process-fork)");
    expect(profile).toContain("(allow signal (target self))");
    // Metadata everywhere — needed for getcwd() and ls path display
    expect(profile).toContain("(allow file-read-metadata)");
    // System library reads needed for bash to even load
    expect(profile).toContain('(allow file-read* (subpath "/usr"))');
    expect(profile).toContain('(allow file-read* (subpath "/System"))');
  });

  it("emits process-exec when subprocess is granted star", async () => {
    const profile = await buildBashProfile({ subprocess: "*" });
    expect(profile).toContain("(allow process-exec*)");
  });

  it("emits per-path subpath rules for path allowlists", async () => {
    // Use a real existing dir so canonicalPath returns a stable
    // canonical form (and on macOS, /tmp/x doesn't exist so canonical
    // path resolves the existing parent).
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-sb-paths-"));
    try {
      const profile = await buildBashProfile({ paths: [dir, "/usr/bin"] });
      // /usr/bin always exists and is itself canonical on macOS.
      expect(profile).toContain('(allow file-read*  (subpath "/usr/bin"))');
      expect(profile).toContain('(allow file-write* (subpath "/usr/bin"))');
      // The tmp dir is canonicalized (e.g. /var/folders/… → /private/var/folders/…).
      const canonical = await fs.realpath(dir);
      expect(profile).toContain(`(allow file-read*  (subpath "${canonical}"))`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("emits unrestricted FS rules for paths = star", async () => {
    const profile = await buildBashProfile({ paths: "*" });
    expect(profile).toContain("(allow file-read*)");
    expect(profile).toContain("(allow file-write*)");
  });

  it("emits network rule only when network is granted star", async () => {
    expect(await buildBashProfile({ network: "*" })).toContain(
      "(allow network*)",
    );
    expect(await buildBashProfile({})).not.toContain("(allow network*)");
    // Empty list = explicit deny; no rule emitted (default-deny covers it)
    expect(await buildBashProfile({ network: [] })).not.toContain(
      "(allow network*)",
    );
  });

  it("escapes embedded quotes and backslashes in path strings", async () => {
    // Non-existent paths fall through canonicalPath's ENOENT recursion
    // and end up resolving the parent (root) and re-appending the
    // basename verbatim, so escaping is exercised on the literal value.
    const profile = await buildBashProfile({
      paths: ['/has"quote', "/has\\back"],
    });
    expect(profile).toContain('(subpath "/has\\"quote")');
    expect(profile).toContain('(subpath "/has\\\\back")');
  });

  it("resolves `./` against the current process.cwd()", async () => {
    // The default grant uses `paths: ["./"]`; the profile must embed
    // the absolute, canonical cwd, not the literal string.
    const profile = await buildBashProfile({ subprocess: "*", paths: ["./"] });
    expect(profile).toContain("(allow process-exec*)");
    const canonicalCwd = await fs.realpath(process.cwd());
    expect(profile).toContain(
      `(allow file-read*  (subpath "${canonicalCwd}"))`,
    );
    expect(profile).toContain(
      `(allow file-write* (subpath "${canonicalCwd}"))`,
    );
    expect(profile).not.toContain('(subpath "./")');
    expect(profile).not.toContain("(allow network*)");
  });

  it("includes the file-read root literal needed for cwd resolution", async () => {
    // Without (allow file-read* (literal "/")) bash exits with SIGABRT
    // before running any user command. Regression guard.
    const profile = await buildBashProfile({});
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
