import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import {
  inspectMcpServer,
  resolveProviderSpec,
  suggestHandle,
} from "../src/cli/mcp-inspect.js";
import { LoomError } from "../src/errors.js";
import { useTmpDir } from "./helpers/tmp.js";

const FIXTURES = path.resolve("test/fixtures");
const ECHO_SERVER = path.join(FIXTURES, "mcp/echo-server.mjs");

describe("loom mcp inspect — provider-spec resolution", () => {
  const tmp = useTmpDir("loom-inspect-");

  async function writeManifest(providersEntry: string): Promise<string> {
    const p = path.join(tmp(), "agent.toml");
    await fs.writeFile(
      p,
      `[agent]
name = "x"
[harness]
provider = "test"
[providers]
${providersEntry}
`,
      "utf8",
    );
    return p;
  }

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
    const p = await writeManifest(
      `my_handle = { provider = "mcp-server", command = "node", args = ["./server.mjs"] }`,
    );
    const r = await resolveProviderSpec("my_handle", { manifestPath: p });
    expect(r.config).toEqual({
      command: "node",
      args: ["./server.mjs"],
    });
    expect(r.source).toBe("manifest:my_handle");
    expect(r.manifestDir).toBe(path.dirname(path.resolve(p)));
  });

  it.each([
    {
      label: "non-mcp-server factory",
      entry: `other = { provider = "some-other-factory" }`,
      handle: "other",
      message: /not 'mcp-server'/,
    },
    {
      label: "SourceSpec entry",
      entry: `local = { path = "./somepkg" }`,
      handle: "local",
      message: /SourceSpec, not a/,
    },
  ])(
    "rejects bare handles pointing at $label",
    async ({ entry, handle, message }) => {
      const p = await writeManifest(entry);
      await expect(
        resolveProviderSpec(handle, { manifestPath: p }),
      ).rejects.toThrow(message);
    },
  );
});

describe("loom mcp inspect — handle suggestion", () => {
  it("strips scope, prefixes, and extensions, then escapes the rest", () => {
    expect(suggestHandle("@modelcontextprotocol/server-filesystem")).toBe(
      "filesystem",
    );
    expect(suggestHandle("mcp-server-linear")).toBe("linear");
    expect(suggestHandle("./bin/echo-server.mjs")).toBe("echo_server");
    expect(suggestHandle("@linear/mcp-server")).toBe("server");
    expect(suggestHandle("./a path with spaces.mjs")).toMatch(/^[a-zA-Z_]/);
    expect(suggestHandle("123-numeric")).toMatch(/^mcp_/);
  });
});

describe("loom mcp inspect — end-to-end against the echo fixture", () => {
  const tmp = useTmpDir("loom-inspect-rt-");

  it("spawns the fixture, lists its tools, and emits a paste-and-prune TOML snippet", async () => {
    const r = await inspectMcpServer(ECHO_SERVER);
    expect(r.serverName).toBe("loom-test-mcp-echo");
    expect(r.serverVersion).toBe("0.0.1");
    expect(r.tools.map((t) => t.name).sort()).toEqual(["add", "echo"]);

    expect(r.toml).toMatch(/^# Tools advertised by /m);
    expect(r.toml).toMatch(/\[providers\]/);
    expect(r.toml).toMatch(/provider = "mcp-server"/);
    expect(r.toml).toMatch(/\[tools\.echo\]/);
    expect(r.toml).toMatch(/\[tools\.add\]/);
    expect(r.toml).toMatch(/\[capabilities\]/);
    expect(r.toml).toMatch(/^# echo = \{ text = "\*" \}$/m);
    expect(r.toml).toMatch(/^# add = \{ a = "\*", b = "\*" \}$/m);
  });

  it("produces a TOML snippet whose [providers] entry round-trips through the parser", async () => {
    const r = await inspectMcpServer(ECHO_SERVER, {
      suggestedHandle: "echo_mcp",
    });
    const p = path.join(tmp(), "agent.toml");
    const manifest = `[agent]
name = "rt"
[harness]
provider = "test"
${r.toml}`;
    await fs.writeFile(p, manifest, "utf8");
    const { parseAgentManifest } = await import("../src/manifest/parser.js");
    const m = await parseAgentManifest(p);
    expect(m.providers?.echo_mcp).toMatchObject({
      provider: "mcp-server",
    });
    expect(m.tools?.echo).toEqual({ provider: "echo_mcp" });
    expect(m.tools?.add).toEqual({ provider: "echo_mcp" });
  });
});
