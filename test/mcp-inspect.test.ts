/**
 * `loom mcp inspect` tests (Chunk 4).
 *
 * Exercises the authoring-aid CLI: provider-spec resolution from
 * paths / npm names / manifest handles, plus the TOML snippet
 * shape. Spawns the test fixture's echo server end-to-end.
 */

import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import {
  inspectMcpServer,
  resolveProviderSpec,
  suggestHandle,
} from "../src/cli/mcp-inspect.js";
import { LoomError } from "../src/errors.js";

const FIXTURES = path.resolve("test/fixtures");
const ECHO_SERVER = path.join(FIXTURES, "mcp/echo-server.mjs");

describe("loom mcp inspect — provider-spec resolution", () => {
  it("treats `./foo` and `/abs/foo.js` as path shorthand", async () => {
    const r1 = await resolveProviderSpec("./bin/server.mjs");
    expect(r1.config).toMatchObject({
      command: process.execPath,
      args: ["./bin/server.mjs"],
    });
    expect(r1.source).toBe("path:./bin/server.mjs");

    const r2 = await resolveProviderSpec("/abs/path/server.js");
    expect(r2.config).toMatchObject({
      command: process.execPath,
      args: ["/abs/path/server.js"],
    });
  });

  it("treats npm-shaped strings as npm shorthand", async () => {
    const r = await resolveProviderSpec("@modelcontextprotocol/server-fs");
    expect(r.config).toEqual({ npm: "@modelcontextprotocol/server-fs" });
    expect(r.source).toBe("npm:@modelcontextprotocol/server-fs");
  });

  it("rejects bare handles without a --manifest", async () => {
    await expect(resolveProviderSpec("my_server")).rejects.toThrow(LoomError);
    await expect(resolveProviderSpec("my_server")).rejects.toThrow(
      /pass --manifest/,
    );
  });

  it("resolves bare handles against the manifest's [providers] table", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-inspect-h-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "x"
[harness]
provider = "test"
[providers]
my_handle = { provider = "mcp-server", command = "node", args = ["./server.mjs"] }
`,
        "utf8",
      );
      const r = await resolveProviderSpec("my_handle", { manifestPath: p });
      expect(r.config).toEqual({
        command: "node",
        args: ["./server.mjs"],
      });
      expect(r.source).toBe("manifest:my_handle");
      expect(r.manifestDir).toBe(path.dirname(path.resolve(p)));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects bare handles pointing at non-mcp-server [providers] entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-inspect-h2-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "x"
[harness]
provider = "test"
[providers]
other = { provider = "some-other-factory" }
`,
        "utf8",
      );
      await expect(
        resolveProviderSpec("other", { manifestPath: p }),
      ).rejects.toThrow(/not 'mcp-server'/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects bare handles pointing at SourceSpec [providers] entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-inspect-h3-"));
    try {
      const p = path.join(dir, "agent.toml");
      await fs.writeFile(
        p,
        `[agent]
name = "x"
[harness]
provider = "test"
[providers]
local = { path = "./somepkg" }
`,
        "utf8",
      );
      await expect(
        resolveProviderSpec("local", { manifestPath: p }),
      ).rejects.toThrow(/SourceSpec, not a/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loom mcp inspect — handle suggestion", () => {
  it("strips scope + common prefixes + extensions", () => {
    expect(suggestHandle("@modelcontextprotocol/server-filesystem")).toBe(
      "filesystem",
    );
    expect(suggestHandle("mcp-server-linear")).toBe("linear");
    // We strip prefixes + extension; suffixes (and embedded hyphens)
    // become underscores so the result is TOML-handle-safe.
    expect(suggestHandle("./bin/echo-server.mjs")).toBe("echo_server");
    // `mcp-` prefix gets stripped → "server".
    expect(suggestHandle("@linear/mcp-server")).toBe("server");
  });

  it("escapes invalid characters and falls back to a default name", () => {
    expect(suggestHandle("./a path with spaces.mjs")).toMatch(/^[a-zA-Z_]/);
    expect(suggestHandle("123-numeric")).toMatch(/^mcp_/);
  });
});

describe("loom mcp inspect — end-to-end against the echo fixture", () => {
  it("spawns the fixture, lists its tools, and emits a paste-and-prune TOML snippet", async () => {
    const r = await inspectMcpServer(ECHO_SERVER);
    expect(r.serverName).toBe("loom-test-mcp-echo");
    expect(r.serverVersion).toBe("0.0.1");
    expect(r.tools.map((t) => t.name).sort()).toEqual(["add", "echo"]);

    // TOML snippet sanity checks: must have a [providers] entry, one
    // [tools.X] per discovered tool, and a [capabilities] block with
    // commented-out hints.
    expect(r.toml).toMatch(/^# Tools advertised by /m);
    expect(r.toml).toMatch(/\[providers\]/);
    expect(r.toml).toMatch(/provider = "mcp-server"/);
    expect(r.toml).toMatch(/\[tools\.echo\]/);
    expect(r.toml).toMatch(/\[tools\.add\]/);
    expect(r.toml).toMatch(/\[capabilities\]/);
    // Capability hints are commented-out lines containing each tool name.
    expect(r.toml).toMatch(/^# echo = /m);
    expect(r.toml).toMatch(/^# add = /m);
    // Hint reflects the schema's properties (text for echo, a+b for add).
    expect(r.toml).toMatch(/^# echo = \{ text = "\*" \}$/m);
    expect(r.toml).toMatch(/^# add = \{ a = "\*", b = "\*" \}$/m);
  });

  it("produces a TOML snippet whose [providers] entry round-trips through the parser", async () => {
    const r = await inspectMcpServer(ECHO_SERVER, {
      suggestedHandle: "echo_mcp",
    });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-inspect-rt-"));
    try {
      const p = path.join(dir, "agent.toml");
      // Wrap the snippet with the minimum manifest scaffolding.
      const manifest = `[agent]
name = "rt"
[harness]
provider = "test"
${r.toml}`;
      await fs.writeFile(p, manifest, "utf8");
      const { parseAgentManifest } = await import("../src/manifest/parser.js");
      const m = await parseAgentManifest(p);
      // The provider entry parses as the configured-factory form.
      expect(m.providers?.echo_mcp).toMatchObject({
        provider: "mcp-server",
      });
      // Both tools appear with the right handle.
      expect(m.tools?.echo).toEqual({ provider: "echo_mcp" });
      expect(m.tools?.add).toEqual({ provider: "echo_mcp" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
