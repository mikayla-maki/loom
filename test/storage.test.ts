/**
 * Per-host data home + per-agent storage tests.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  resolveAgentStorage,
  resolveLoomDataHome,
  transientStorage,
} from "../src/runtime/storage.js";
import { LoomError } from "../src/errors.js";
import type { AgentManifest } from "../src/types/manifest.js";
import { useTmpDir } from "./helpers/tmp.js";

describe("resolveLoomDataHome", () => {
  it.each<[NodeJS.Platform]>([["darwin"], ["linux"], ["win32"]])(
    "honours LOOM_DATA_HOME above platform conventions on %s",
    (platform) => {
      expect(
        resolveLoomDataHome({ LOOM_DATA_HOME: "/custom/dir" }, platform),
      ).toBe("/custom/dir");
    },
  );

  it.each<[NodeJS.Platform, Record<string, string>, string]>([
    [
      "darwin",
      { HOME: "/Users/alice" },
      "/Users/alice/Library/Application Support/Loom",
    ],
    ["linux", { HOME: "/home/alice", XDG_DATA_HOME: "/x/d/h" }, "/x/d/h/loom"],
    ["linux", { HOME: "/home/alice" }, "/home/alice/.local/share/loom"],
    [
      "win32",
      { APPDATA: "C:\\Users\\alice\\AppData" },
      path.join("C:\\Users\\alice\\AppData", "Loom"),
    ],
    [
      "win32",
      { USERPROFILE: "C:/Users/alice" },
      path.join("C:/Users/alice", "AppData", "Roaming", "Loom"),
    ],
    [
      "freebsd" as NodeJS.Platform,
      { HOME: "/home/alice" },
      "/home/alice/.loom",
    ],
  ])("platform=%s env=%j → %s", (platform, env, expected) => {
    expect(resolveLoomDataHome(env, platform)).toBe(expected);
  });

  it("throws when neither LOOM_DATA_HOME nor HOME is set", () => {
    expect(() => resolveLoomDataHome({}, "darwin")).toThrow(LoomError);
    expect(() => resolveLoomDataHome({}, "darwin")).toThrow(
      /Cannot resolve Loom data home/,
    );
  });
});

function manifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    name: "test-agent",
    harness: { provider: "test" },
    ...overrides,
  };
}

describe("resolveAgentStorage", () => {
  const tmp = useTmpDir("loom-storage-");

  it("creates <dataHome>/agents/<name>/ on first open and drops .loom-agent metadata", async () => {
    const dataHome = tmp();
    const r = await resolveAgentStorage(
      manifest({ name: "scribe", manifestPath: "/abs/path/agent.toml" }),
      { LOOM_DATA_HOME: dataHome },
    );
    expect(r.path).toBe(path.join(dataHome, "agents", "scribe"));
    expect(r.source).toBe("name");
    expect(r.warnings).toEqual([]);
    // The directory exists.
    const stat = await fs.stat(r.path);
    expect(stat.isDirectory()).toBe(true);
    // Metadata is present and well-formed.
    const meta = JSON.parse(
      await fs.readFile(path.join(r.path, ".loom-agent"), "utf8"),
    );
    expect(meta.agentName).toBe("scribe");
    expect(meta.storageId).toBe("scribe");
    expect(meta.createdByManifest).toBe("/abs/path/agent.toml");
    expect(meta.knownManifests).toEqual(["/abs/path/agent.toml"]);
  });

  it("re-opens with the same manifest path silently (no warnings)", async () => {
    const m = manifest({
      name: "scribe",
      manifestPath: "/abs/path/agent.toml",
    });
    await resolveAgentStorage(m, { LOOM_DATA_HOME: tmp() });
    const r2 = await resolveAgentStorage(m, { LOOM_DATA_HOME: tmp() });
    expect(r2.warnings).toEqual([]);
  });

  it("warns when a different manifest path opens an existing storage, and records both in knownManifests", async () => {
    await resolveAgentStorage(
      manifest({ name: "scribe", manifestPath: "/path/one.toml" }),
      { LOOM_DATA_HOME: tmp() },
    );
    const r2 = await resolveAgentStorage(
      manifest({ name: "scribe", manifestPath: "/path/two.toml" }),
      { LOOM_DATA_HOME: tmp() },
    );
    expect(r2.warnings).toHaveLength(1);
    expect(r2.warnings[0]).toMatch(/previously opened by \/path\/one\.toml/);
    expect(r2.warnings[0]).toMatch(/now opened by \/path\/two\.toml/);
    const meta = JSON.parse(
      await fs.readFile(path.join(r2.path, ".loom-agent"), "utf8"),
    );
    expect(meta.knownManifests.sort()).toEqual([
      "/path/one.toml",
      "/path/two.toml",
    ]);
  });

  it("[agent].storage_id overrides [agent].name and is reported as the source", async () => {
    const r = await resolveAgentStorage(
      manifest({ name: "scribe", storageId: "my-pinned-id" }),
      { LOOM_DATA_HOME: tmp() },
    );
    expect(r.path).toBe(path.join(tmp(), "agents", "my-pinned-id"));
    expect(r.source).toBe("storage_id");
  });

  it("sanitises punctuation in identifiers and rejects path separators", async () => {
    const r = await resolveAgentStorage(manifest({ name: "my agent v2.0" }), {
      LOOM_DATA_HOME: tmp(),
    });
    // Spaces sanitised to `_`; dots preserved.
    expect(path.basename(r.path)).toBe("my_agent_v2.0");

    await expect(
      resolveAgentStorage(manifest({ name: "evil/../escape" }), {
        LOOM_DATA_HOME: tmp(),
      }),
    ).rejects.toThrow(/path separator/);
  });

  it("creates storage for manifests without a manifestPath (pre-built / SDK callers)", async () => {
    const r = await resolveAgentStorage(manifest({ name: "in-memory" }), {
      LOOM_DATA_HOME: tmp(),
    });
    expect(r.warnings).toEqual([]);
    const meta = JSON.parse(
      await fs.readFile(path.join(r.path, ".loom-agent"), "utf8"),
    );
    expect(meta.createdByManifest).toBeNull();
    expect(meta.knownManifests).toEqual([]);
  });
});

describe("transientStorage", () => {
  it("returns an absolute path under os.tmpdir()", () => {
    const p = transientStorage("loom-foo");
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.startsWith(os.tmpdir())).toBe(true);
    expect(p).toContain("loom-foo");
  });
});
