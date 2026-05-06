import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { resolveAgent } from "../src/manifest/resolver.js";
import { CapabilityError, ManifestError } from "../src/errors.js";

const FIXTURES = path.resolve("test/fixtures");

describe("resolveAgent", () => {
  it("resolves the sample agent end-to-end", async () => {
    const r = await resolveAgent(path.join(FIXTURES, "sample-agent/agent.toml"));
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0]?.manifest.name).toBe("greeter");
    expect(r.tools.map((t) => t.manifest.tool.name).sort()).toEqual(["greet", "uppercase"]);
    expect(r.systemPrompt).toMatch(/Sample Agent/);
    expect(r.requiredSecrets.has("sample_user_name")).toBe(true);
    expect(r.pathAdditions).toHaveLength(2);
  });

  it("rejects when a tool needs a capability outside the ceiling", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glass-cap-"));
    try {
      // Create a tool that wants network = ["evil.com"] outside the ceiling
      const toolDir = path.join(dir, "tools", "snoop");
      await fs.mkdir(toolDir, { recursive: true });
      await fs.writeFile(
        path.join(toolDir, "tool.toml"),
        `[tool]
name = "snoop"
description = "snoop"
[tool.schema]
type = "object"
[tool.invocation]
command = "echo"
[tool.secrets]
required = []
[tool.capabilities]
filesystem = []
network = ["evil.com"]
`,
        "utf8",
      );
      const skillDir = path.join(dir, "skills", "snoop-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: snoop-skill
description: tries to snoop
requires:
  snoop: ../../tools/snoop
---
body`,
        "utf8",
      );
      const agentDir = path.join(dir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "snoopy"
system_prompt = "x"
[harness]
provider = "test"
[session]
provider = "memory"
[sandbox]
filesystem = []
network = []
secrets = []
[skills]
s = "../skills/snoop-skill"
`,
        "utf8",
      );
      await expect(resolveAgent(path.join(agentDir, "agent.toml"))).rejects.toThrow(
        CapabilityError,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects when SKILL.md requires a tool whose [tool].name disagrees", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glass-name-"));
    try {
      const toolDir = path.join(dir, "tools", "actually-bar");
      await fs.mkdir(toolDir, { recursive: true });
      await fs.writeFile(
        path.join(toolDir, "tool.toml"),
        `[tool]
name = "bar"
description = "x"
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
      const skillDir = path.join(dir, "skills", "wrong");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: wrong
description: bad
requires:
  foo: ../../tools/actually-bar
---
body`,
        "utf8",
      );
      const agentDir = path.join(dir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "n"
system_prompt = "x"
[harness]
provider = "test"
[session]
provider = "memory"
[sandbox]
filesystem = []
network = []
secrets = []
[skills]
w = "../skills/wrong"
`,
        "utf8",
      );
      await expect(resolveAgent(path.join(agentDir, "agent.toml"))).rejects.toThrow(
        ManifestError,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves [agent].system_prompt as inline string when not path-like", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glass-sp-inline-"));
    try {
      const agentDir = path.join(dir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "inline-sp"
system_prompt = "Be concise. Use only tools provided."
[harness]
provider = "test"
[session]
provider = "memory"
[sandbox]
filesystem = []
network = []
secrets = []
[skills]
`,
      );
      const r = await resolveAgent(path.join(agentDir, "agent.toml"));
      expect(r.systemPrompt).toBe("Be concise. Use only tools provided.");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves [agent].system_prompt as a file when path-like", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glass-sp-path-"));
    try {
      const agentDir = path.join(dir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(path.join(agentDir, "core.md"), "# Core\n\nbe brief\n");
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "path-sp"
system_prompt = "./core.md"
[harness]
provider = "test"
[session]
provider = "memory"
[sandbox]
filesystem = []
network = []
secrets = []
[skills]
`,
      );
      const r = await resolveAgent(path.join(agentDir, "agent.toml"));
      expect(r.systemPrompt).toMatch(/be brief/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves builtin tools by the requires-key shorthand", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glass-builtin-"));
    try {
      const skillDir = path.join(dir, "skills", "shell");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: shell
description: bash access
requires:
  bash: builtin
---
body`,
        "utf8",
      );
      const agentDir = path.join(dir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "x"
system_prompt = "x"
[harness]
provider = "test"
[session]
provider = "memory"
[sandbox]
filesystem = ["./"]
network = []
secrets = []
[skills]
s = "../skills/shell"
`,
        "utf8",
      );
      const r = await resolveAgent(path.join(agentDir, "agent.toml"));
      expect(r.tools.map((t) => t.manifest.tool.name)).toEqual(["bash"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
