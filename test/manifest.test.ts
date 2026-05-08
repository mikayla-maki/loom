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
    // [capabilities] is now per-tool: each value is whatever shape that tool
    // expects (here `{ paths: ["./"] }`).
    expect(m.capabilities?.read_file).toEqual({ paths: ["./"] });
    expect(m.capabilities?.write_file).toEqual({ paths: ["./"] });
    expect(m.capabilities?.find).toEqual({ paths: ["./"] });
    // [tools] now lists the default builtin set, configured for the project root.
    expect(m.tools).toMatchObject({
      read_file: { paths: ["./"] },
      write_file: { paths: ["./"] },
      find: { paths: ["./"] },
      echo: {},
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

  it("parses an explicit [tools] table (string-valued)", async () => {
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
provider = "memory"
`,
        "utf8",
      );
      const m = await parseAgentManifest(p);
      expect(m.systemPrompt).toBe("You are a friendly demo agent.");
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
provider = "memory"
`,
        "utf8",
      );
      const m = await parseAgentManifest(p);
      expect(m.systemPrompt).toBe("./prompt.md");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
