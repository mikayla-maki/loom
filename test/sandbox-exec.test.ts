import { describe, expect, it } from "vitest";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import {
  buildBashProfile,
  sandboxEngaged,
  validateBashGrant,
} from "../src/runtime/sandbox/sandbox-exec.js";
import { withTmpDir } from "./helpers/tmp.js";

describe("sandboxEngaged", () => {
  it("opts out only for the whole-tool star grant", () => {
    expect(sandboxEngaged("*")).toBe(false);
    expect(sandboxEngaged({})).toBe(true);
    expect(sandboxEngaged({ commands: "*" })).toBe(true);
    expect(sandboxEngaged({ commands: ["pwd"] })).toBe(true);
  });
});

describe("buildBashProfile", () => {
  it("throws on a `*` grant", async () => {
    await expect(buildBashProfile("*")).rejects.toThrow(/no sandbox/);
  });

  it("emits the version, default-deny, and bash baseline rules", async () => {
    const profile = await buildBashProfile({});
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(allow process-fork)");
    expect(profile).toContain("(allow signal (target self))");
    expect(profile).toContain("(allow file-read-metadata)");
    expect(profile).toContain('(allow file-read* (subpath "/usr"))');
    expect(profile).toContain('(allow file-read* (subpath "/System"))');
    // Without this literal bash exits with SIGABRT before any command runs.
    expect(profile).toContain('(allow file-read* (literal "/"))');
    expect(profile).not.toContain("(allow network*)");
  });

  it("allows process-exec for both shell and argv command grants", async () => {
    expect(await buildBashProfile({ commands: "*" })).toContain(
      "(allow process-exec*)",
    );
    expect(await buildBashProfile({ commands: ["pwd", "cat"] })).toContain(
      "(allow process-exec*)",
    );
  });

  it("emits canonicalized per-path subpath rules for path allowlists", async () => {
    await withTmpDir("loom-sb-paths-", async (dir) => {
      const profile = await buildBashProfile({ paths: [dir, "/usr/bin"] });
      expect(profile).toContain('(allow file-read*  (subpath "/usr/bin"))');
      expect(profile).toContain('(allow file-write* (subpath "/usr/bin"))');
      const canonical = await fs.realpath(dir);
      expect(profile).toContain(`(allow file-read*  (subpath "${canonical}"))`);
    });
  });

  it("expands a leading ~ to the home directory before resolving", async () => {
    const profile = await buildBashProfile({ paths: ["~/loom-tilde-grant"] });
    const expected = nodePath.join(
      await fs.realpath(os.homedir()),
      "loom-tilde-grant",
    );
    expect(profile).toContain(`(allow file-read*  (subpath "${expected}"))`);
    expect(profile).not.toContain('subpath "~');
    expect(profile).not.toContain(`${process.cwd()}/~`);
  });

  it("emits unrestricted FS rules for paths = star", async () => {
    const profile = await buildBashProfile({ paths: "*" });
    expect(profile).toContain("(allow file-read*)");
    expect(profile).toContain("(allow file-write*)");
  });

  it("emits the network rule only for network = star", async () => {
    expect(await buildBashProfile({ network: "*" })).toContain(
      "(allow network*)",
    );
    expect(await buildBashProfile({})).not.toContain("(allow network*)");
    expect(await buildBashProfile({ network: [] })).not.toContain(
      "(allow network*)",
    );
  });

  it("escapes embedded quotes and backslashes in path strings", async () => {
    const profile = await buildBashProfile({
      paths: ['/has"quote', "/has\\back"],
    });
    expect(profile).toContain('(subpath "/has\\"quote")');
    expect(profile).toContain('(subpath "/has\\\\back")');
  });

  it("resolves `./` against the canonical process.cwd()", async () => {
    const profile = await buildBashProfile({ commands: "*", paths: ["./"] });
    const canonicalCwd = await fs.realpath(process.cwd());
    expect(profile).toContain("(allow process-exec*)");
    expect(profile).toContain(
      `(allow file-read*  (subpath "${canonicalCwd}"))`,
    );
    expect(profile).toContain(
      `(allow file-write* (subpath "${canonicalCwd}"))`,
    );
    expect(profile).not.toContain('(subpath "./")');
    expect(profile).not.toContain("(allow network*)");
  });
});

describe("validateBashGrant", () => {
  it("accepts the star, empty, and command grants", () => {
    expect(() => validateBashGrant("*")).not.toThrow();
    expect(() => validateBashGrant({})).not.toThrow();
    expect(() => validateBashGrant({ commands: "*" })).not.toThrow();
    expect(() => validateBashGrant({ commands: ["ls", "rg"] })).not.toThrow();
    expect(() => validateBashGrant({ commands: ["pwd"] })).not.toThrow();
  });

  it("rejects empty or non-string command lists", () => {
    expect(() => validateBashGrant({ commands: [] })).toThrow(/non-empty array/);
    expect(() =>
      validateBashGrant({ commands: ["ls", 42] } as unknown as never),
    ).toThrow(/non-empty array/);
  });

  it("accepts paths = star or string array; rejects other shapes", () => {
    expect(() => validateBashGrant({ paths: "*" })).not.toThrow();
    expect(() => validateBashGrant({ paths: ["./", "/tmp"] })).not.toThrow();
    expect(() => validateBashGrant({ paths: [] })).not.toThrow();
    expect(() => validateBashGrant({ paths: 42 } as unknown as never)).toThrow(
      /array of strings/,
    );
    expect(() =>
      validateBashGrant({ paths: ["./", 42] } as unknown as never),
    ).toThrow(/array of strings/);
  });

  it("rejects network host allowlists, which sandbox-exec cannot filter", () => {
    expect(() => validateBashGrant({ network: "*" })).not.toThrow();
    expect(() => validateBashGrant({ network: [] })).not.toThrow();
    expect(() => validateBashGrant({ network: ["example.com"] })).toThrow(
      /per-host/i,
    );
  });

  it("accepts env = star or string array; rejects other shapes", () => {
    expect(() => validateBashGrant({ env: "*" })).not.toThrow();
    expect(() => validateBashGrant({ env: ["PATH", "AWS_*"] })).not.toThrow();
    expect(() =>
      validateBashGrant({ env: { PATH: "/usr/bin" } } as unknown as never),
    ).toThrow(/array of strings/);
  });
});
