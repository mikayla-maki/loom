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

describe("resolveLoomDataHome", () => {
  it("honours LOOM_DATA_HOME above platform conventions on every OS", () => {
    expect(
      resolveLoomDataHome({ LOOM_DATA_HOME: "/custom/dir" }, "darwin"),
    ).toBe("/custom/dir");
    expect(
      resolveLoomDataHome({ LOOM_DATA_HOME: "/custom/dir" }, "linux"),
    ).toBe("/custom/dir");
    expect(
      resolveLoomDataHome({ LOOM_DATA_HOME: "/custom/dir" }, "win32"),
    ).toBe("/custom/dir");
  });

  it("uses ~/Library/Application Support/Loom on macOS", () => {
    expect(resolveLoomDataHome({ HOME: "/Users/alice" }, "darwin")).toBe(
      "/Users/alice/Library/Application Support/Loom",
    );
  });

  it("uses $XDG_DATA_HOME/loom on Linux when set, else ~/.local/share/loom", () => {
    expect(
      resolveLoomDataHome(
        { HOME: "/home/alice", XDG_DATA_HOME: "/x/d/h" },
        "linux",
      ),
    ).toBe("/x/d/h/loom");
    expect(resolveLoomDataHome({ HOME: "/home/alice" }, "linux")).toBe(
      "/home/alice/.local/share/loom",
    );
  });

  it("uses %APPDATA%/Loom on Windows when set, else ~/AppData/Roaming/Loom", () => {
    expect(
      resolveLoomDataHome({ APPDATA: "C:\\Users\\alice\\AppData" }, "win32"),
    ).toBe(path.join("C:\\Users\\alice\\AppData", "Loom"));
    expect(resolveLoomDataHome({ USERPROFILE: "C:/Users/alice" }, "win32")).toBe(
      path.join("C:/Users/alice", "AppData", "Roaming", "Loom"),
    );
  });

  it("falls back to ~/.loom on unknown platforms", () => {
    expect(
      resolveLoomDataHome(
        { HOME: "/home/alice" },
        "freebsd" as NodeJS.Platform,
      ),
    ).toBe("/home/alice/.loom");
  });

  it("throws when neither LOOM_DATA_HOME nor HOME is set", () => {
    expect(() => resolveLoomDataHome({}, "darwin")).toThrow(LoomError);
    expect(() => resolveLoomDataHome({}, "darwin")).toThrow(
      /Cannot resolve Loom data home/,
    );
  });
});

async function mktemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function manifest(
  overrides: Partial<AgentManifest> = {},
): AgentManifest {
  return {
    name: "test-agent",
    harness: { provider: "test" },
    ...overrides,
  };
}

describe("resolveAgentStorage", () => {
  it("creates <dataHome>/agents/<name>/ on first open and drops .loom-agent metadata", async () => {
    const dataHome = await mktemp("loom-storage-fresh-");
    try {
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
    } finally {
      await fs.rm(dataHome, { recursive: true, force: true });
    }
  });

  it("re-opens with the same manifest path silently (no warnings)", async () => {
    const dataHome = await mktemp("loom-storage-reopen-");
    try {
      const m = manifest({
        name: "scribe",
        manifestPath: "/abs/path/agent.toml",
      });
      await resolveAgentStorage(m, { LOOM_DATA_HOME: dataHome });
      const r2 = await resolveAgentStorage(m, { LOOM_DATA_HOME: dataHome });
      expect(r2.warnings).toEqual([]);
    } finally {
      await fs.rm(dataHome, { recursive: true, force: true });
    }
  });

  it("warns when a different manifest path opens an existing storage, and records both in knownManifests", async () => {
    const dataHome = await mktemp("loom-storage-collide-");
    try {
      await resolveAgentStorage(
        manifest({ name: "scribe", manifestPath: "/path/one.toml" }),
        { LOOM_DATA_HOME: dataHome },
      );
      const r2 = await resolveAgentStorage(
        manifest({ name: "scribe", manifestPath: "/path/two.toml" }),
        { LOOM_DATA_HOME: dataHome },
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
    } finally {
      await fs.rm(dataHome, { recursive: true, force: true });
    }
  });

  it("[agent].storage_id overrides [agent].name and is reported as the source", async () => {
    const dataHome = await mktemp("loom-storage-id-");
    try {
      const r = await resolveAgentStorage(
        manifest({ name: "scribe", storageId: "my-pinned-id" }),
        { LOOM_DATA_HOME: dataHome },
      );
      expect(r.path).toBe(path.join(dataHome, "agents", "my-pinned-id"));
      expect(r.source).toBe("storage_id");
    } finally {
      await fs.rm(dataHome, { recursive: true, force: true });
    }
  });

  it("sanitises punctuation in identifiers and rejects path separators", async () => {
    const dataHome = await mktemp("loom-storage-sanitise-");
    try {
      const r = await resolveAgentStorage(
        manifest({ name: "my agent v2.0" }),
        { LOOM_DATA_HOME: dataHome },
      );
      // Spaces sanitised to `_`; dots preserved.
      expect(path.basename(r.path)).toBe("my_agent_v2.0");

      await expect(
        resolveAgentStorage(manifest({ name: "evil/../escape" }), {
          LOOM_DATA_HOME: dataHome,
        }),
      ).rejects.toThrow(/path separator/);
    } finally {
      await fs.rm(dataHome, { recursive: true, force: true });
    }
  });

  it("creates storage for manifests without a manifestPath (pre-built / SDK callers)", async () => {
    const dataHome = await mktemp("loom-storage-no-path-");
    try {
      const r = await resolveAgentStorage(manifest({ name: "in-memory" }), {
        LOOM_DATA_HOME: dataHome,
      });
      expect(r.warnings).toEqual([]);
      const meta = JSON.parse(
        await fs.readFile(path.join(r.path, ".loom-agent"), "utf8"),
      );
      expect(meta.createdByManifest).toBeNull();
      expect(meta.knownManifests).toEqual([]);
    } finally {
      await fs.rm(dataHome, { recursive: true, force: true });
    }
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
