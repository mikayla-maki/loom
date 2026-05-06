import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { runAgent } from "../src/sdk/run-agent.js";
import { LocalRegistry } from "../src/registry/registry.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type { TurnScript } from "../src/extensions/harness/test.js";

const FIXTURES = path.resolve("test/fixtures");
void FIXTURES;

/**
 * Build a tmp $LOOM_HOME with two registry-installed skills.
 *
 *   - safe-skill   (no extra capabilities)
 *   - net-skill    (declares network = ['extra.example.com'])
 *
 * The test only verifies that `search_skills` enumerates them and rolls
 * up their declared capabilities for the `fitsCeiling` field. Adding
 * skills to a running agent isn't a runtime concern any more — the
 * client re-runs `runAgent()` with an updated manifest.
 */
async function buildHomeWithSkills(): Promise<{
  home: string;
  cleanup: () => Promise<void>;
}> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "loom-disco-"));
  const reg = new LocalRegistry({ root: home });

  const safeSrc = path.join(home, "_src", "safe");
  await fs.mkdir(safeSrc, { recursive: true });
  await fs.writeFile(
    path.join(safeSrc, "SKILL.md"),
    `---
name: safe-skill
description: Safe skill — no extra capabilities.
requires:
  reverse: ./tools/reverse
---
body
`,
  );
  const reverseDir = path.join(safeSrc, "tools", "reverse");
  await fs.mkdir(path.join(reverseDir, "bin"), { recursive: true });
  await fs.writeFile(
    path.join(reverseDir, "tool.toml"),
    `[tool]
name = "reverse"
description = "Reverse a string"
[tool.schema]
type = "object"
required = ["text"]
properties.text.type = "string"
[tool.invocation]
command = "test-reverse"
[tool.secrets]
required = []
[tool.capabilities]
filesystem = []
network = []
`,
  );
  await reg.install("skill", safeSrc);

  const netSrc = path.join(home, "_src", "net");
  await fs.mkdir(netSrc, { recursive: true });
  await fs.writeFile(
    path.join(netSrc, "SKILL.md"),
    `---
name: net-skill
description: Skill that needs additional network capability.
requires:
  pingish: ./tools/pingish
---
body
`,
  );
  const pingDir = path.join(netSrc, "tools", "pingish");
  await fs.mkdir(path.join(pingDir, "bin"), { recursive: true });
  await fs.writeFile(
    path.join(pingDir, "tool.toml"),
    `[tool]
name = "pingish"
description = "Pretends to ping"
[tool.schema]
type = "object"
required = ["host"]
properties.host.type = "string"
[tool.invocation]
command = "test-pingish"
[tool.secrets]
required = []
[tool.capabilities]
filesystem = []
network = ["extra.example.com"]
`,
  );
  await reg.install("skill", netSrc);

  return {
    home,
    cleanup: async () => {
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}

/**
 * Build an inline agent that brings `search_skills` into scope as a
 * builtin, within the given `[sandbox]` ceiling.
 */
function buildAgent(
  opts: {
    ceilingNetwork?: string[];
    script?: TurnScript[];
  } = {},
): AgentManifest {
  return {
    name: "discoverer",
    systemPrompt: "x",
    removeBuiltinTools: true,
    harness: {
      provider: "test",
      ...(opts.script ? { script: opts.script } : {}),
    },
    sandbox: {
      filesystem: ["./"],
      network: opts.ceilingNetwork ?? [],
      secrets: [],
    },
    skills: {
      discovery: {
        description: "Skill discovery.",
        body: "Use search_skills to list candidates.\n",
        requires: {
          search_skills: "builtin",
        },
      },
    },
  };
}

describe("search_skills — read-only skill enumeration", () => {
  it("lists registry-installed skills with capability rollups", async () => {
    const { home, cleanup } = await buildHomeWithSkills();
    const old = process.env.LOOM_HOME;
    process.env.LOOM_HOME = home;
    try {
      const agent = await runAgent(
        buildAgent({
          script: [
            [
              { call: { tool: "search_skills", input: {} } },
              { stop: "end_turn" },
            ],
          ],
        }),
        {},
      );
      try {
        await agent.prompt("list");
        const events = await agent.session.getEvents();
        const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
        expect(tu).toBeTruthy();
        if (tu && tu.sessionUpdate === "tool_call_update") {
          const text =
            tu.content?.[0]?.type === "content" &&
            tu.content[0].content.type === "text"
              ? tu.content[0].content.text
              : "";
          const parsed = JSON.parse(text) as Array<{
            name: string;
            fitsCeiling: boolean;
            capabilities: { network?: string[] };
          }>;
          const byName = new Map(parsed.map((s) => [s.name, s]));
          expect(byName.has("safe-skill")).toBe(true);
          expect(byName.has("net-skill")).toBe(true);
          // Rolled-up caps reach search_skills.
          expect(byName.get("net-skill")?.capabilities.network).toEqual([
            "extra.example.com",
          ]);
          // Within current ceiling (network=[]), net-skill does NOT fit.
          expect(byName.get("net-skill")?.fitsCeiling).toBe(false);
          expect(byName.get("safe-skill")?.fitsCeiling).toBe(true);
        }
      } finally {
        await agent.close();
      }
    } finally {
      if (old === undefined) delete process.env.LOOM_HOME;
      else process.env.LOOM_HOME = old;
      await cleanup();
    }
  });

  it("filters by query (substring on name + description)", async () => {
    const { home, cleanup } = await buildHomeWithSkills();
    const old = process.env.LOOM_HOME;
    process.env.LOOM_HOME = home;
    try {
      const agent = await runAgent(
        buildAgent({
          script: [
            [
              { call: { tool: "search_skills", input: { query: "net" } } },
              { stop: "end_turn" },
            ],
          ],
        }),
        {},
      );
      try {
        await agent.prompt("filter");
        const events = await agent.session.getEvents();
        const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
        if (tu && tu.sessionUpdate === "tool_call_update") {
          const text =
            tu.content?.[0]?.type === "content" &&
            tu.content[0].content.type === "text"
              ? tu.content[0].content.text
              : "";
          const parsed = JSON.parse(text) as Array<{ name: string }>;
          const names = parsed.map((s) => s.name);
          expect(names).toContain("net-skill");
          expect(names).not.toContain("safe-skill");
        }
      } finally {
        await agent.close();
      }
    } finally {
      if (old === undefined) delete process.env.LOOM_HOME;
      else process.env.LOOM_HOME = old;
      await cleanup();
    }
  });
});
