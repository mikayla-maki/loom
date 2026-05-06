import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { runAgent } from "../src/sdk/run-agent.js";
import { auditAgent } from "../src/audit/audit.js";
import { CapabilityError } from "../src/errors.js";
import { memorySessionFactory } from "../src/extensions/session/memory.js";
import { testHarnessFactory } from "../src/extensions/harness/test.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";

/**
 * Build a small fixtures tree on disk:
 *   parent/agent.toml    — parent agent that has skill 'composer'
 *   skills/composer       — declares subagent 'helper'
 *   helper/agent.toml    — child agent (test harness, scripted to say "child here")
 */
async function buildSubagentFixture(opts: {
  parentSubagentCeiling: string[] | "*";
  skillSubagents: { helper: string; rude?: string };
}): Promise<{ root: string; parentManifest: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "glass-sub-"));

  // Helper child agent under skills/ so subagents.toml's relative paths
  // (which resolve from skills/composer/) can reach it via ../helper/...
  const helperDir = path.join(root, "skills", "helper");
  await fs.mkdir(helperDir, { recursive: true });
  await fs.writeFile(
    path.join(helperDir, "agent.toml"),
    `[agent]
name = "helper"
system_prompt = "child"
[harness]
provider = "test"
echo = true
[session]
provider = "memory"
[sandbox]
filesystem = []
network = []
secrets = []
[skills]
`,
  );

  // Composer skill.
  const skillDir = path.join(root, "skills", "composer");
  await fs.mkdir(skillDir, { recursive: true });
  const subagentsToml = Object.entries(opts.skillSubagents)
    .map(([k, v]) => `${k} = "${v}"`)
    .join("\n");
  await fs.writeFile(path.join(skillDir, "subagents.toml"), subagentsToml);
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: composer
description: Compose by delegating
requires: {}
subagents: ./subagents.toml
---
body
`,
  );

  // Parent agent.
  const parentDir = path.join(root, "parent");
  await fs.mkdir(parentDir, { recursive: true });
  const ceiling =
    opts.parentSubagentCeiling === "*"
      ? `subagent = "*"`
      : `subagent = [${opts.parentSubagentCeiling.map((s) => `"${s}"`).join(", ")}]`;
  await fs.writeFile(
    path.join(parentDir, "agent.toml"),
    `[agent]
name = "parent"
system_prompt = "parent"
[harness]
provider = "test"
[session]
provider = "memory"
[sandbox]
filesystem = []
network = []
secrets = []
${ceiling}
[skills]
composer = "../skills/composer"
`,
  );

  return { root, parentManifest: path.join(parentDir, "agent.toml") };
}

describe("subagents", () => {
  it("v1: parent calls helper via spawn_subagent end-to-end", async () => {
    const { root, parentManifest } = await buildSubagentFixture({
      parentSubagentCeiling: ["helper"],
      skillSubagents: { helper: "../helper/agent.toml" },
    });
    try {
      const agent = await runAgent(parentManifest, {
        sessionOverride: memorySessionFactory,
        harnessOverride: {
          factory: testHarnessFactory,
          config: {
            // Sub-harness for the child runs by default; pass child config via
            // a separate runAgent invocation if needed. Here we drive the parent
            // to call spawn_subagent.
            script: [
              [
                {
                  call: {
                    tool: "spawn_subagent",
                    input: { scope: "helper", prompt: "hello child" },
                  },
                },
                { stop: "end_turn" },
              ],
            ],
          },
        },
      });
      try {
        await agent.prompt("delegate");
        const events = await agent.session.getEvents();
        const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
        expect(tu).toBeTruthy();
        if (tu && tu.sessionUpdate === "tool_call_update") {
          expect(tu.status).toBe("completed");
          const text =
            tu.content?.[0]?.type === "content" && tu.content[0].content.type === "text"
              ? tu.content[0].content.text
              : "";
          // Child runs in echo mode → returns "echo: hello child"
          expect(text).toContain("echo: hello child");
        }
      } finally {
        await agent.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("v1: refuses to escape parent's [sandbox].subagent ceiling", async () => {
    const { root, parentManifest } = await buildSubagentFixture({
      parentSubagentCeiling: ["helper"],
      skillSubagents: { helper: "../helper/agent.toml", rude: "../helper/agent.toml" },
    });
    try {
      // Resolver should refuse to even start since 'rude' is not in ceiling.
      await expect(
        runAgent(parentManifest, {
          sessionOverride: memorySessionFactory,
          harnessOverride: {
            factory: testHarnessFactory,
            config: { script: [] },
          },
        }),
      ).rejects.toThrow(CapabilityError);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("v1: subagent='*' passthrough is permitted only when ceiling is also '*'", async () => {
    const { root, parentManifest } = await buildSubagentFixture({
      parentSubagentCeiling: "*",
      skillSubagents: { helper: "../helper/agent.toml" },
    });
    try {
      const agent = await runAgent(parentManifest, {
        sessionOverride: memorySessionFactory,
        harnessOverride: {
          factory: testHarnessFactory,
          config: {
            script: [
              [{ call: { tool: "spawn_subagent", input: { scope: "helper", prompt: "ping" } } }, { stop: "end_turn" }],
            ],
          },
        },
      });
      try {
        const stop = await agent.prompt("go");
        expect(stop).toBe("end_turn");
      } finally {
        await agent.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("auditAgent recursively traverses subagents", async () => {
    const { root, parentManifest } = await buildSubagentFixture({
      parentSubagentCeiling: ["helper"],
      skillSubagents: { helper: "../helper/agent.toml" },
    });
    try {
      const tree = await auditAgent(parentManifest);
      expect(tree.subagents).toHaveLength(1);
      expect(tree.subagents[0]?.name).toBe("helper");
      expect(tree.subagents[0]?.tree?.name).toBe("helper");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("auditAgent surfaces acp:// subagents as remote", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "glass-acp-"));
    try {
      const skillDir = path.join(root, "skills", "remote");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: remote
description: remote subagent
requires: {}
subagents:
  helper: acp://example.com:9000/helper
---
body
`,
      );
      const parentDir = path.join(root, "p");
      await fs.mkdir(parentDir, { recursive: true });
      await fs.writeFile(
        path.join(parentDir, "agent.toml"),
        `[agent]
name = "p"
system_prompt = "p"
[harness]
provider = "test"
[session]
provider = "memory"
[sandbox]
filesystem = []
network = []
secrets = []
subagent = ["helper"]
[skills]
r = "../skills/remote"
`,
      );
      const tree = await auditAgent(path.join(parentDir, "agent.toml"));
      expect(tree.subagents).toHaveLength(1);
      expect(tree.subagents[0]?.kind).toBe("acp");
      expect(tree.subagents[0]?.note).toMatch(/acp:\/\/example.com/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
