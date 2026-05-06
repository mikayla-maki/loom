import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { auditAgent, formatCapabilityTree } from "../src/audit/audit.js";

const FIXTURES = path.resolve("test/fixtures");

describe("auditAgent", () => {
  it("produces a static capability tree for the sample agent", async () => {
    const tree = await auditAgent(path.join(FIXTURES, "sample-agent/agent.toml"));
    expect(tree.name).toBe("sample-agent");
    expect(tree.tools.map((t) => t.name).sort()).toEqual([
      "bash",
      "find",
      "greet",
      "read_file",
      "uppercase",
      "write_file",
    ]);
    expect(tree.required.secrets).toEqual(["sample_user_name"]);
    expect(tree.subagents).toHaveLength(0);
    const printed = formatCapabilityTree(tree);
    expect(printed).toContain("sample-agent");
    expect(printed).toContain("uppercase");
  });

  it("breaks cycles when a subagent references itself", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "glass-cycle-"));
    try {
      // Build agent A that calls A as a subagent (via skill).
      const agentDir = path.join(root, "self");
      await fs.mkdir(agentDir, { recursive: true });
      const skillDir = path.join(root, "skills", "loop");
      await fs.mkdir(skillDir, { recursive: true });
      // Subagent points back at the same agent.toml.
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: loop
description: self-loop
requires: {}
subagents:
  me: ${path.join(agentDir, "agent.toml")}
---
body
`,
      );
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "self"
system_prompt = "x"
remove_builtin_tools = true

[harness]
provider = "test"
[session]
provider = "memory"
[sandbox]
filesystem = []
network = []
secrets = []
subagent = ["me"]
[skills]
l = "../skills/loop"
`,
      );
      const tree = await auditAgent(path.join(agentDir, "agent.toml"));
      expect(tree.name).toBe("self");
      expect(tree.subagents).toHaveLength(1);
      expect(tree.subagents[0]?.tree?.name).toBe("(cycle)");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
