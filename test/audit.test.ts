import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { auditAgent, formatCapabilityTree } from "../src/audit/audit.js";
import type { AgentManifest } from "../src/types/manifest.js";

const FIXTURES = path.resolve("test/fixtures");

describe("auditAgent", () => {
  it("produces a static capability tree for the sample agent", async () => {
    // The sample agent fixture stays file-based on purpose: it exercises
    // both the [skills] disk dependency walk and tool/skill capability
    // ceiling aggregation end-to-end. Inline specs are covered below.
    const tree = await auditAgent(
      path.join(FIXTURES, "sample-agent/agent.toml"),
    );
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

  it("surfaces every declared secret with its requesters", async () => {
    const spec: AgentManifest = {
      name: "secret-surface",
      systemPrompt: "p",
      removeBuiltinTools: true,
      // Anthropic harness declares ANTHROPIC_API_KEY required.
      harness: { provider: "anthropic", model: "claude-3-haiku-20240307" },
      sandbox: { filesystem: [], network: [], secrets: [] },
      skills: {
        s: {
          description: "x",
          requires: {
            t1: {
              description: "needs A required + SHARED required",
              schema: { type: "object" },
              invocation: { command: "echo" },
              secrets: { required: ["A_TOKEN", "SHARED"] },
            },
            t2: {
              description: "needs SHARED optional + B optional",
              schema: { type: "object" },
              invocation: { command: "echo" },
              secrets: { optional: ["SHARED", "B_TOKEN"] },
            },
          },
        },
      },
    };
    const tree = await auditAgent(spec);
    const byName = new Map(tree.secrets.map((s) => [s.name, s]));
    expect(byName.get("ANTHROPIC_API_KEY")?.required).toBe(true);
    expect(byName.get("ANTHROPIC_API_KEY")?.requestedBy).toEqual([
      "harness:anthropic",
    ]);
    expect(byName.get("A_TOKEN")?.required).toBe(true);
    // Required wins on conflict: SHARED is required because t1 wants it.
    expect(byName.get("SHARED")?.required).toBe(true);
    expect(byName.get("SHARED")?.requestedBy).toEqual(["tool:t1"]);
    // B is optional-only.
    expect(byName.get("B_TOKEN")?.required).toBe(false);

    const printed = formatCapabilityTree(tree);
    expect(printed).toContain("secrets:");
    expect(printed).toContain("ANTHROPIC_API_KEY [required]");
    expect(printed).toContain("B_TOKEN [optional]");
  });

  it("audits an inline spec without touching the filesystem", async () => {
    const spec: AgentManifest = {
      name: "inline",
      systemPrompt: "p",
      removeBuiltinTools: true,
      harness: { provider: "test" },
      sandbox: { filesystem: [], network: [], secrets: [] },
      skills: {
        s: {
          description: "x",
          requires: {
            t: {
              description: "noop",
              schema: { type: "object" },
              invocation: { command: "echo" },
              capabilities: { filesystem: [], network: [] },
            },
          },
        },
      },
    };
    const tree = await auditAgent(spec);
    expect(tree.name).toBe("inline");
    expect(tree.tools.map((t) => t.name).sort()).toEqual(["t"]);
    expect(tree.subagents).toHaveLength(0);
  });

  it("breaks cycles when a subagent references itself", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-cycle-"));
    try {
      // The self-loop has to live on disk: the inline parent declares a
      // subagent pointing at the very same agent.toml the auditor is
      // walking. The cycle must be broken regardless.
      const agentDir = path.join(root, "self");
      await fs.mkdir(agentDir, { recursive: true });
      const skillDir = path.join(root, "skills", "loop");
      await fs.mkdir(skillDir, { recursive: true });
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
