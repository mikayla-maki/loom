import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { parseAgentManifest } from "../src/manifest/parser.js";
import { ManifestError } from "../src/errors.js";
import { useTmpDir } from "./helpers/tmp.js";

const FIXTURES = path.resolve("test/fixtures");

describe("agent.toml parser", () => {
  const tmp = useTmpDir("loom-manifest-");

  /** Writes `agent.toml` with `body` and returns its absolute path. */
  async function writeManifest(body: string): Promise<string> {
    const p = path.join(tmp(), "agent.toml");
    await fs.writeFile(p, body, "utf8");
    return p;
  }

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
    expect(m.capabilities?.edit_file).toEqual({ paths: ["./"] });
    expect(m.capabilities?.find).toEqual({ paths: ["./"] });
    // v5: tool entries are tables (with a required `provider` field)
    // or the string shorthand. The sample agent uses the string form
    // `"builtin"` for its native tools.
    expect(m.tools).toEqual({
      read_file: "builtin",
      write_file: "builtin",
      edit_file: "builtin",
      find: "builtin",
    });
  });

  it("rejects manifests missing required sections", async () => {
    // [session] and [capabilities] are now optional, so a manifest can omit
    // them. Missing required sections that should still throw: [agent]
    // (or [agent].name), and [harness].provider.
    const p = await writeManifest('[agent]\nname = "x"\n[harness]\n');
    await expect(parseAgentManifest(p)).rejects.toThrow(ManifestError);
  });

  it("parses an explicit [tools] table with string shorthand (v3)", async () => {
    // v3: string shorthand still works — it's a bare provider ref.
    // `"builtin"` resolves to the native provider; `"./local-tool"`
    // resolves to a local-path source.
    const p = await writeManifest(`[agent]
name = "with-tools"
system_prompt = "x"

[harness]
provider = "test"
[tools]
bash = "builtin"
my_thing = "./local-tool"
`);
    const m = await parseAgentManifest(p);
    expect(m.tools).toEqual({
      bash: "builtin",
      my_thing: "./local-tool",
    });
  });

  it("parses tool entries with inline SourceSpec table providers", async () => {
    const p = await writeManifest(`[agent]
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
`);
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
  });

  it("rejects [tools.X] entries with an empty table", async () => {
    const p = await writeManifest(`[agent]
name = "empty-entry"
system_prompt = "x"
[harness]
provider = "test"
[tools]
bash = {}
`);
    await expect(parseAgentManifest(p)).rejects.toThrow(
      /\[tools\]\.bash is missing required 'provider' field/,
    );
  });

  it("rejects stray keys in a SourceSpec table", async () => {
    const p = await writeManifest(`[agent]
name = "stray"
system_prompt = "x"
[harness]
provider = { npm = "@my-org/harness", greeting = "hi" }
`);
    await expect(parseAgentManifest(p)).rejects.toThrow(/is not a known key/);
  });

  it("distinguishes absent [tools] from empty [tools] (defaults vs. opt-out)", async () => {
    // 1) absent [tools] section
    const a = path.join(tmp(), "absent.toml");
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
    const b = path.join(tmp(), "empty.toml");
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
  });

  it("system_prompt accepts an inline string (no path prefix)", async () => {
    const p = await writeManifest(`[agent]
name = "x"
system_prompt = "You are a friendly demo agent."
[tools]

[harness]
provider = "test"
[session]
provider = "in-memory"
`);
    const m = await parseAgentManifest(p);
    expect(m.systemPrompt).toBe("You are a friendly demo agent.");
  });

  it("parses [[session.layers]] (dotted-key array-of-tables) into a layered session", async () => {
    const p = await writeManifest(`[agent]
name = "layered"
system_prompt = "x"
[harness]
provider = "test"

[[session.layers]]
provider = "compacting"
threshold = 60

[[session.layers]]
provider = "in-memory"
`);
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
  });

  it("parses inline [session].layers with all-string shorthand", async () => {
    const p = await writeManifest(`[agent]
name = "inline-layered"
system_prompt = "x"
[harness]
provider = "test"

[session]
layers = ["skills", "compacting", "in-memory"]
`);
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
  });

  it("parses inline [session].layers with all-table form (config per layer)", async () => {
    const p = await writeManifest(`[agent]
name = "inline-tables"
system_prompt = "x"
[harness]
provider = "test"

[session]
layers = [
  { provider = "compacting", threshold = 60 },
  { provider = "file", path = "./s.jsonl" },
]
`);
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
  });

  it("singleton [session] (provider only) still parses as a single SessionSpec", async () => {
    const p = await writeManifest(`[agent]
name = "single"
system_prompt = "x"
[harness]
provider = "test"

[session]
provider = "in-memory"
`);
    const m = await parseAgentManifest(p);
    // Singleton stays as a plain table (not an array).
    expect(Array.isArray(m.session)).toBe(false);
    if (m.session && "provider" in m.session) {
      expect(m.session.provider).toBe("in-memory");
    } else {
      throw new Error("expected SessionSpec");
    }
  });

  it("rejects empty [session].layers", async () => {
    const p = await writeManifest(`[agent]
name = "empty"
system_prompt = "x"
[harness]
provider = "test"
[session]
layers = []
`);
    await expect(parseAgentManifest(p)).rejects.toThrow(
      /\[session\]\.layers is empty/,
    );
  });

  it("rejects [session] with both 'provider' and 'layers'", async () => {
    const p = await writeManifest(`[agent]
name = "both"
system_prompt = "x"
[harness]
provider = "test"
[session]
provider = "in-memory"
layers = ["compacting", "in-memory"]
`);
    await expect(parseAgentManifest(p)).rejects.toThrow(
      /has both 'provider' and 'layers'/,
    );
  });

  it("rejects [session] with neither 'provider' nor 'layers'", async () => {
    const p = await writeManifest(`[agent]
name = "neither"
system_prompt = "x"
[harness]
provider = "test"
[session]
`);
    await expect(parseAgentManifest(p)).rejects.toThrow(
      /missing both 'provider' and 'layers'/,
    );
  });

  it("rejects the old top-level [[session]] form with a pointer at [session].layers", async () => {
    const p = await writeManifest(`[agent]
name = "old-chain"
system_prompt = "x"
[harness]
provider = "test"

[[session]]
provider = "compacting"

[[session]]
provider = "in-memory"
`);
    await expect(parseAgentManifest(p)).rejects.toThrow(
      /\[session\] with a 'layers' array/,
    );
  });

  it("system_prompt accepts a path-like string", async () => {
    const p = await writeManifest(`[agent]
name = "x"
system_prompt = "./prompt.md"
[tools]

[harness]
provider = "test"
[session]
provider = "in-memory"
`);
    const m = await parseAgentManifest(p);
    expect(m.systemPrompt).toBe("./prompt.md");
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
    const p = await writeManifest(`[agent]
name = "prov-cf"
system_prompt = "x"
[harness]
provider = "test"

[providers]
fs_mcp = { provider = "test-meta", npm = "@example/mcp-fs" }
linear  = { provider = "test-meta", command = "npx", args = ["@linear/mcp"] }
`);
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
  });

  it("still parses [providers] entries in the SourceSpec form alongside configured-factory", async () => {
    const p = await writeManifest(`[agent]
name = "prov-mixed"
system_prompt = "x"
[harness]
provider = "test"

[providers]
local     = { path = "./my-tools" }
npm_thing = "@scope/pkg"
mcp_thing = { provider = "test-meta", npm = "@example/mcp" }
`);
    const m = await parseAgentManifest(p);
    expect(m.providers).toEqual({
      local: { path: "./my-tools" },
      npm_thing: "@scope/pkg",
      mcp_thing: { provider: "test-meta", npm: "@example/mcp" },
    });
  });

  it("parses [agent].storage_id override", async () => {
    const p = await writeManifest(`[agent]
name = "x"
storage_id = "pinned-id"
[harness]
provider = "test"
`);
    const m = await parseAgentManifest(p);
    expect(m.storageId).toBe("pinned-id");
  });

  it("rejects [agent].storage_id containing path separators", async () => {
    const p = await writeManifest(`[agent]
name = "x"
storage_id = "../escape"
[harness]
provider = "test"
`);
    await expect(parseAgentManifest(p)).rejects.toThrow(
      /storage_id.*path separator/,
    );
  });

  it("still rejects bare-handle strings as [providers] entries", async () => {
    const p = await writeManifest(`[agent]
name = "prov-bare"
system_prompt = "x"
[harness]
provider = "test"

[providers]
oops = "some_handle"
`);
    await expect(parseAgentManifest(p)).rejects.toThrow(
      /Bare handles aren't allowed at this layer/,
    );
  });
});
