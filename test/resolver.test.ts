import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { resolveAgent } from "../src/manifest/resolver.js";
import { CapabilityError, ManifestError } from "../src/errors.js";
import type { AgentManifest } from "../src/types/manifest.js";

const FIXTURES = path.resolve("test/fixtures");

describe("resolveAgent", () => {
  it("resolves the sample agent end-to-end (with the default top-level tool set)", async () => {
    // The sample agent fixture stays file-based on purpose: it exercises
    // both the [skills] disk dependency walk and tool/skill capability
    // ceiling aggregation end-to-end.
    const r = await resolveAgent(
      path.join(FIXTURES, "sample-agent/agent.toml"),
    );
    // The sample agent doesn't declare [tools], so it gets the default
    // builtin set; one explicit skill brings two more tools.
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0]?.manifest.name).toBe("greeter");
    expect(r.tools.map((t) => t.manifest.name).sort()).toEqual([
      "bash",
      "find",
      "greet",
      "read_file",
      "uppercase",
      "write_file",
    ]);
    // Top-level tools are tagged distinctly from skill-supplied tools.
    const topLevelNames = r.tools
      .filter((t) => t.introducedBy === "(top-level)")
      .map((t) => t.manifest.name)
      .sort();
    expect(topLevelNames).toEqual(["bash", "find", "read_file", "write_file"]);
    expect(r.systemPrompt).toMatch(/Sample Agent/);
    expect(r.requiredSecrets.has("sample_user_name")).toBe(true);
    // pathAdditions: 4 default-set tool bin dirs + 2 manifest tool bin dirs.
    expect(r.pathAdditions).toHaveLength(6);
  });

  it("empty [tools] table opts out of the default builtin set", async () => {
    // The greeter skill stays on disk (it's a fixture) but the parent
    // agent is declared inline and points at it via absolute path.
    const greeterPath = path.join(FIXTURES, "skills/greeter");
    const spec: AgentManifest = {
      name: "no-defaults",
      systemPrompt: "be brief",
      tools: {},
      harness: { provider: "test" },
      sandbox: { filesystem: ["./"], secrets: ["sample_user_name"] },
      skills: { greeter: greeterPath },
    };
    const r = await resolveAgent(spec);
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0]?.manifest.name).toBe("greeter");
    expect(r.tools.map((t) => t.manifest.name).sort()).toEqual([
      "greet",
      "uppercase",
    ]);
  });

  it("top-level [tools] is a hard error when colliding with a skill's requires", async () => {
    const spec: AgentManifest = {
      name: "collision",
      systemPrompt: "x",
      tools: { bash: "builtin" },
      harness: { provider: "test" },
      sandbox: { filesystem: ["./"], network: [], secrets: [] },
      skills: {
        s: {
          description: "also brings bash",
          requires: { bash: "builtin" },
        },
      },
    };
    await expect(resolveAgent(spec)).rejects.toThrow(
      /declared at the top level AND brought in by skill/,
    );
  });

  it("rejects when a tool needs a capability outside the ceiling", async () => {
    const spec: AgentManifest = {
      name: "snoopy",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test" },
      sandbox: { filesystem: [], network: [], secrets: [] },
      skills: {
        s: {
          description: "tries to snoop",
          requires: {
            snoop: {
              description: "snoop",
              schema: { type: "object" },
              invocation: { command: "echo" },
              capabilities: { filesystem: [], network: ["evil.com"] },
            },
          },
        },
      },
    };
    await expect(resolveAgent(spec)).rejects.toThrow(CapabilityError);
  });

  it("rejects when SKILL.md requires a tool whose [tool].name disagrees", async () => {
    // This test specifically exercises parser-level name validation
    // where the on-disk tool.toml's [tool].name differs from the
    // requires-key. Inline specs validate name-vs-key at materialize
    // time (different code path), so we keep this on disk.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-name-"));
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
[tools]

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
      await expect(
        resolveAgent(path.join(agentDir, "agent.toml")),
      ).rejects.toThrow(ManifestError);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves [agent].system_prompt as inline string when not path-like", async () => {
    const spec: AgentManifest = {
      name: "inline-sp",
      systemPrompt: "Be concise. Use only tools provided.",
      tools: {},
      harness: { provider: "test" },
      skills: {},
    };
    const r = await resolveAgent(spec);
    expect(r.systemPrompt).toBe("Be concise. Use only tools provided.");
  });

  it("resolves [agent].system_prompt as a file when path-like", async () => {
    // Path-like system_prompt is a file-on-disk feature; the inline
    // path stays a literal string. This test must remain file-based.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-sp-path-"));
    try {
      const agentDir = path.join(dir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "core.md"),
        "# Core\n\nbe brief\n",
      );
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "path-sp"
system_prompt = "./core.md"
[tools]

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
    const spec: AgentManifest = {
      name: "x",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test" },
      sandbox: { filesystem: ["./"], network: [], secrets: [] },
      skills: {
        s: {
          description: "bash access",
          requires: { bash: "builtin" },
        },
      },
    };
    const r = await resolveAgent(spec);
    expect(r.tools.map((t) => t.manifest.name)).toEqual(["bash"]);
  });
});
