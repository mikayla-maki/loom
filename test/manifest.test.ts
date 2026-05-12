import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { parseAgentManifest } from "../src/manifest/parser.js";
import { ManifestError } from "../src/errors.js";

const FIXTURES = path.resolve("test/fixtures");

describe("agent.toml parser", () => {
  it("parses the sample agent.toml", async () => {
    const m = await parseAgentManifest(
      path.join(FIXTURES, "sample-agent/agent.toml"),
    );
    expect(m.name).toBe("sample-agent");
    if ("provider" in m.harness) expect(m.harness.provider).toBe("test");
    if (m.session && "provider" in m.session)
      expect(m.session.provider).toBe("file");
    // [agent].secrets allowlist parsed.
    expect(m.secrets).toEqual(["sample_user_name"]);
    // Per-tool capability grants. The fixture uses per-kind maps for
    // each FS tool; the `"*"` whole-tool form is exercised elsewhere.
    expect(m.capabilities?.read_file).toEqual({ paths: ["./"] });
    expect(m.capabilities?.write_file).toEqual({ paths: ["./"] });
    expect(m.capabilities?.find).toEqual({ paths: ["./"] });
    // v5: tool entries are tables (with a required `provider` field)
    // or the string shorthand. The sample agent uses the string form
    // `"builtin"` for its native tools.
    expect(m.tools).toEqual({
      read_file: "builtin",
      write_file: "builtin",
      find: "builtin",
    });
  });

  it("rejects manifests missing required sections", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-bad-"));
    try {
      // [session] and [capabilities] are now optional, so a manifest can omit
      // them. Missing required sections that should still throw: [agent]
      // (or [agent].name), and [harness].provider.
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(p, '[agent]\nname = "x"\n[harness]\n', "utf8");
      await expect(parseAgentManifest(p)).rejects.toThrow(ManifestError);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("parses an explicit [tools] table with string shorthand (v3)", async () => {
    // v3: string shorthand still works — it's a bare provider ref.
    // `"builtin"` resolves to the native provider; `"./local-tool"`
    // resolves to a local-path source.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-tools-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "with-tools"
system_prompt = "x"

[harness]
provider = "test"
[tools]
bash = "builtin"
my_thing = "./local-tool"
`,
        "utf8",
      );
      const m = await parseAgentManifest(p);
      expect(m.tools).toEqual({
        bash: "builtin",
        my_thing: "./local-tool",
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("parses tool entries with inline SourceSpec table providers", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-tools-tbl-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "with-tools-tbl"
system_prompt = "x"

[harness]
provider = "test"

[tools.fs_read]
provider = { npm = "@my-org/mcp" }
server = "stdio"

[tools.local_grep]
provider = { path = "../my-fast-grep" }
flags = ["-i"]
`,
        "utf8",
      );
      const m = await parseAgentManifest(p);
      expect(m.tools).toEqual({
        fs_read: {
          provider: { npm: "@my-org/mcp" },
          server: "stdio",
        },
        local_grep: {
          provider: { path: "../my-fast-grep" },
          flags: ["-i"],
        },
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects [tools.X] entries with an empty table", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-empty-tool-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "empty-entry"
system_prompt = "x"
[harness]
provider = "test"
[tools]
bash = {}
`,
        "utf8",
      );
      await expect(parseAgentManifest(p)).rejects.toThrow(
        /\[tools\]\.bash is missing required 'provider' field/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects stray keys in a SourceSpec table", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-stray-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "stray"
system_prompt = "x"
[harness]
provider = { npm = "@my-org/harness", greeting = "hi" }
`,
        "utf8",
      );
      await expect(parseAgentManifest(p)).rejects.toThrow(/is not a known key/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes absent [tools] from empty [tools] (defaults vs. opt-out)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-tools-empty-"));
    try {
      // 1) absent [tools] section
      const a = path.join(dir, "absent.toml");
      await fs.writeFile(
        a,
        `[agent]
name = "absent"
system_prompt = "x"
[harness]
provider = "test"
`,
        "utf8",
      );
      const ma = await parseAgentManifest(a);
      expect(ma.tools).toBeUndefined();

      // 2) explicit empty [tools] section
      const b = path.join(dir, "empty.toml");
      await fs.writeFile(
        b,
        `[agent]
name = "empty"
system_prompt = "x"
[harness]
provider = "test"
[tools]
`,
        "utf8",
      );
      const mb = await parseAgentManifest(b);
      expect(mb.tools).toEqual({});
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("system_prompt accepts an inline string (no path prefix)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-inline-sp-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "x"
system_prompt = "You are a friendly demo agent."
[tools]

[harness]
provider = "test"
[session]
provider = "in-memory"
`,
        "utf8",
      );
      const m = await parseAgentManifest(p);
      expect(m.systemPrompt).toBe("You are a friendly demo agent.");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("parses [[session.layers]] (dotted-key array-of-tables) into a layered session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-layers-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "layered"
system_prompt = "x"
[harness]
provider = "test"

[[session.layers]]
provider = "compacting"
threshold = 60

[[session.layers]]
provider = "in-memory"
`,
        "utf8",
      );
      const m = await parseAgentManifest(p);
      expect(Array.isArray(m.session)).toBe(true);
      const layers = m.session as Array<{
        provider: unknown;
        [k: string]: unknown;
      }>;
      expect(layers).toHaveLength(2);
      expect(layers[0]).toMatchObject({
        provider: "compacting",
        threshold: 60,
      });
      expect(layers[1]).toMatchObject({ provider: "in-memory" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("parses inline [session].layers with all-string shorthand", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-inline-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "inline-layered"
system_prompt = "x"
[harness]
provider = "test"

[session]
layers = ["skills", "compacting", "in-memory"]
`,
        "utf8",
      );
      const m = await parseAgentManifest(p);
      const layers = m.session as Array<{
        provider: unknown;
        [k: string]: unknown;
      }>;
      expect(layers).toHaveLength(3);
      // String shorthand expands to `{ provider: "<string>" }`.
      expect(layers[0]).toEqual({ provider: "skills" });
      expect(layers[1]).toEqual({ provider: "compacting" });
      expect(layers[2]).toEqual({ provider: "in-memory" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("parses inline [session].layers with all-table form (config per layer)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-inline-tables-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "inline-tables"
system_prompt = "x"
[harness]
provider = "test"

[session]
layers = [
  { provider = "compacting", threshold = 60 },
  { provider = "file", path = "./s.jsonl" },
]
`,
        "utf8",
      );
      const m = await parseAgentManifest(p);
      const layers = m.session as Array<{
        provider: unknown;
        [k: string]: unknown;
      }>;
      expect(layers).toHaveLength(2);
      expect(layers[0]).toMatchObject({
        provider: "compacting",
        threshold: 60,
      });
      expect(layers[1]).toMatchObject({
        provider: "file",
        path: "./s.jsonl",
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("singleton [session] (provider only) still parses as a single SessionSpec", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-single-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "single"
system_prompt = "x"
[harness]
provider = "test"

[session]
provider = "in-memory"
`,
        "utf8",
      );
      const m = await parseAgentManifest(p);
      // Singleton stays as a plain table (not an array).
      expect(Array.isArray(m.session)).toBe(false);
      if (m.session && "provider" in m.session) {
        expect(m.session.provider).toBe("in-memory");
      } else {
        throw new Error("expected SessionSpec");
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects empty [session].layers", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-empty-layers-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "empty"
system_prompt = "x"
[harness]
provider = "test"
[session]
layers = []
`,
        "utf8",
      );
      await expect(parseAgentManifest(p)).rejects.toThrow(
        /\[session\]\.layers is empty/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects [session] with both 'provider' and 'layers'", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-both-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "both"
system_prompt = "x"
[harness]
provider = "test"
[session]
provider = "in-memory"
layers = ["compacting", "in-memory"]
`,
        "utf8",
      );
      await expect(parseAgentManifest(p)).rejects.toThrow(
        /has both 'provider' and 'layers'/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects [session] with neither 'provider' nor 'layers'", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-neither-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "neither"
system_prompt = "x"
[harness]
provider = "test"
[session]
`,
        "utf8",
      );
      await expect(parseAgentManifest(p)).rejects.toThrow(
        /missing both 'provider' and 'layers'/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects the old top-level [[session]] form with a pointer at [session].layers", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-old-chain-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "old-chain"
system_prompt = "x"
[harness]
provider = "test"

[[session]]
provider = "compacting"

[[session]]
provider = "in-memory"
`,
        "utf8",
      );
      await expect(parseAgentManifest(p)).rejects.toThrow(
        /\[session\] with a 'layers' array/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("system_prompt accepts a path-like string", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-path-sp-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "x"
system_prompt = "./prompt.md"
[tools]

[harness]
provider = "test"
[session]
provider = "in-memory"
`,
        "utf8",
      );
      const m = await parseAgentManifest(p);
      expect(m.systemPrompt).toBe("./prompt.md");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // ─── [providers] configured-factory form (MCP integration, Chunk 1) ───
  //
  // The configured-factory form lets a [providers] entry name a Tools
  // factory (built-in or, in future, source-loaded) plus per-handle
  // config. Same shape as [harness] / [session] / [tools.X]:
  // `{ provider = "<factory>", ...config }`. The big use case is MCP
  // servers via the built-in `mcp-server` factory, but the shape is
  // factory-agnostic — these parser tests use a fake `test-meta`
  // factory name to exercise the plumbing without depending on
  // anything that hasn't been built yet.

  it("parses [providers] entries in the configured-factory form", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-prov-cf-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "prov-cf"
system_prompt = "x"
[harness]
provider = "test"

[providers]
fs_mcp = { provider = "test-meta", npm = "@example/mcp-fs" }
linear  = { provider = "test-meta", command = "npx", args = ["@linear/mcp"] }
`,
        "utf8",
      );
      const m = await parseAgentManifest(p);
      expect(m.providers).toEqual({
        fs_mcp: {
          provider: "test-meta",
          npm: "@example/mcp-fs",
        },
        linear: {
          provider: "test-meta",
          command: "npx",
          args: ["@linear/mcp"],
        },
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("still parses [providers] entries in the SourceSpec form alongside configured-factory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-prov-mixed-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "prov-mixed"
system_prompt = "x"
[harness]
provider = "test"

[providers]
local     = { path = "./my-tools" }
npm_thing = "@scope/pkg"
mcp_thing = { provider = "test-meta", npm = "@example/mcp" }
`,
        "utf8",
      );
      const m = await parseAgentManifest(p);
      expect(m.providers).toEqual({
        local: { path: "./my-tools" },
        npm_thing: "@scope/pkg",
        mcp_thing: { provider: "test-meta", npm: "@example/mcp" },
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("parses [agent].storage_id override", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-storage-id-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "x"
storage_id = "pinned-id"
[harness]
provider = "test"
`,
        "utf8",
      );
      const m = await parseAgentManifest(p);
      expect(m.storageId).toBe("pinned-id");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects [agent].storage_id containing path separators", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-storage-bad-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "x"
storage_id = "../escape"
[harness]
provider = "test"
`,
        "utf8",
      );
      await expect(parseAgentManifest(p)).rejects.toThrow(
        /storage_id.*path separator/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("still rejects bare-handle strings as [providers] entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-prov-bare-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "prov-bare"
system_prompt = "x"
[harness]
provider = "test"

[providers]
oops = "some_handle"
`,
        "utf8",
      );
      await expect(parseAgentManifest(p)).rejects.toThrow(
        /Bare handles aren't allowed at this layer/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
