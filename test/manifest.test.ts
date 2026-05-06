import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import {
  parseAgentManifest,
  parseSkillManifest,
  parseToolManifest,
  parseSubagentsFile,
} from "../src/manifest/parser.js";
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
    expect(m.sandbox?.filesystem).toEqual(["./"]);
    expect(m.sandbox?.secrets).toEqual(["sample_user_name"]);
    expect(m.skills).toMatchObject({ greeter: "../skills/greeter" });
  });

  it("rejects manifests missing required sections", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-bad-"));
    try {
      // [session] and [sandbox] are now optional, so a manifest can omit
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
[sandbox]
filesystem = ["./"]
network = []
secrets = []
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
[sandbox]
filesystem = []
[skills]
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
[sandbox]
filesystem = []
[skills]
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

describe("tool.toml parser", () => {
  it("parses a complete tool manifest including capabilities", async () => {
    const t = await parseToolManifest(path.join(FIXTURES, "tools/whoami"));
    expect(t.name).toBe("greet");
    expect(t.invocation.command).toBe("sample-greet");
    expect(t.secrets?.required).toEqual(["sample_user_name"]);
    expect(t.capabilities?.secrets).toEqual(["sample_user_name"]);
    expect(t.shipsBinary).toBe(true);
    expect(t.binDir).toBe(path.join(FIXTURES, "tools/whoami", "bin"));
  });

  it("flags shipsBinary false when no bin/ exists", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-tool-"));
    try {
      await fs.writeFile(
        path.join(dir, "tool.toml"),
        `[tool]
name = "noop"
description = "noop"
[tool.schema]
type = "object"
[tool.invocation]
command = "echo"
[tool.secrets]
required = []
[tool.capabilities]
filesystem = []
network = []
`,
        "utf8",
      );
      const t = await parseToolManifest(dir);
      expect(t.shipsBinary).toBe(false);
      expect(t.binDir).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("SKILL.md parser", () => {
  it("parses the greeter skill", async () => {
    const s = await parseSkillManifest(path.join(FIXTURES, "skills/greeter"));
    expect(s.name).toBe("greeter");
    expect(s.description).toMatch(/greet/i);
    expect(s.requires).toEqual({
      greet: "../../tools/whoami",
      uppercase: "../../tools/uppercase",
    });
    expect(s.body).toMatch(/Greeter/);
  });

  it("supports inline subagents mapping", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-skill-"));
    try {
      await fs.writeFile(
        path.join(dir, "SKILL.md"),
        `---
name: rich
description: A skill with subagents
requires: {}
subagents:
  helper: ../helper/agent.toml
  remote: acp://example.com:1234/foo
  registry: my-helper
---
body
`,
        "utf8",
      );
      const s = await parseSkillManifest(dir);
      expect(s.subagents?.helper).toEqual({
        kind: "path",
        path: "../helper/agent.toml",
      });
      expect(s.subagents?.remote).toEqual({
        kind: "acp",
        url: "acp://example.com:1234/foo",
      });
      expect(s.subagents?.registry).toEqual({
        kind: "registry",
        name: "my-helper",
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("supports subagents declared as a path to subagents.toml", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-skill-"));
    try {
      await fs.writeFile(
        path.join(dir, "SKILL.md"),
        `---
name: with-subagents-file
description: stuff
requires: {}
subagents: ./subagents.toml
---
body`,
        "utf8",
      );
      await fs.writeFile(
        path.join(dir, "subagents.toml"),
        `compactor = "./compactor/agent.toml"\nremote = "acp://x:1/y"\n`,
        "utf8",
      );
      const s = await parseSkillManifest(dir);
      expect(s.subagents?.__file__).toEqual({
        kind: "path",
        path: "./subagents.toml",
      });

      const file = await parseSubagentsFile(path.join(dir, "subagents.toml"));
      expect(file.compactor).toEqual({
        kind: "path",
        path: "./compactor/agent.toml",
      });
      expect(file.remote).toEqual({ kind: "acp", url: "acp://x:1/y" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
