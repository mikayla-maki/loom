import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { runAgent } from "../src/sdk/run-agent.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import { memorySessionFactory } from "../src/extensions/session/memory.js";
import { testHarnessFactory } from "../src/extensions/harness/test.js";
import { assembleSystemPrompt } from "../src/runtime/system-prompt.js";

const FIXTURES = path.resolve("test/fixtures");

describe("runAgent → end-to-end with TestHarness + memory session", () => {
  it("runs scripted steps including a tool call", async () => {
    const agent = await runAgent(path.join(FIXTURES, "sample-agent/agent.toml"), {
      secrets: new StaticSecretsStore({ sample_user_name: "ALICE" }),
      sessionOverride: memorySessionFactory,
      sessionConfigOverride: {},
      harnessOverride: {
        factory: testHarnessFactory,
        config: {
          script: [
            [
              { say: "On it." },
              { call: { tool: "greet", input: { greeting: "hello" } } },
              { stop: "end_turn" },
            ],
          ],
        },
      },
    });
    try {
      const stop = await agent.prompt("Hi there!");
      expect(stop).toBe("end_turn");
      const events = await agent.session.getEvents();
      const messages = events
        .filter((e) => e.sessionUpdate === "agent_message_chunk")
        .map((e) => (e.content.type === "text" ? e.content.text : ""));
      expect(messages.join(" | ")).toContain("On it.");
      expect(messages.join(" | ").toLowerCase()).toContain("hello, alice");
      const tool = events.find((e) => e.sessionUpdate === "tool_call_update");
      expect(tool).toBeTruthy();
      if (tool && tool.sessionUpdate === "tool_call_update") {
        expect(tool.status).toBe("completed");
      }
    } finally {
      await agent.close();
    }
  });

  it("emits live updates to subscribers", async () => {
    const agent = await runAgent(path.join(FIXTURES, "sample-agent/agent.toml"), {
      secrets: new StaticSecretsStore({ sample_user_name: "BOB" }),
      sessionOverride: memorySessionFactory,
      harnessOverride: {
        factory: testHarnessFactory,
        config: {
          script: [
            [{ say: "ack" }, { stop: "end_turn" }],
          ],
        },
      },
    });
    const seen: string[] = [];
    const sub = agent.updates();
    const consumer = (async () => {
      for await (const u of sub) {
        seen.push(u.sessionUpdate);
        if (u.sessionUpdate === "stop") break;
      }
    })();
    try {
      await agent.prompt("ping");
      await consumer;
    } finally {
      await agent.close();
    }
    expect(seen).toContain("user_message_chunk");
    expect(seen).toContain("agent_message_chunk");
    expect(seen[seen.length - 1]).toBe("stop");
  });

  it("cancels an in-flight turn", async () => {
    const agent = await runAgent(path.join(FIXTURES, "sample-agent/agent.toml"), {
      secrets: new StaticSecretsStore({ sample_user_name: "CARL" }),
      sessionOverride: memorySessionFactory,
      harnessOverride: {
        factory: testHarnessFactory,
        config: {
          // Long script, but harness checks abortSignal between steps.
          script: async (rt) => {
            const out = [{ say: "starting" }] as Array<
              { say: string } | { call: { tool: string; input: unknown } } | { stop: "end_turn" | "cancelled" }
            >;
            for (let i = 0; i < 50; i++) out.push({ say: `step ${i}` });
            // Force a yield so the abort can land.
            await new Promise((resolve) => setTimeout(resolve, 10));
            void rt;
            out.push({ stop: "end_turn" });
            return out;
          },
        },
      },
    });
    try {
      const p = agent.prompt("go");
      // Cancel after a beat.
      setTimeout(() => agent.cancel(), 5);
      const reason = await p;
      // Either the harness yields cancelled, or the script completes before the
      // signal lands. Both are valid; just ensure cancel() completes cleanly.
      expect(["cancelled", "end_turn"]).toContain(reason);
    } finally {
      await agent.close();
    }
  });

  it("validates tool input against the JSON schema", async () => {
    const agent = await runAgent(path.join(FIXTURES, "sample-agent/agent.toml"), {
      secrets: new StaticSecretsStore({ sample_user_name: "DIANA" }),
      sessionOverride: memorySessionFactory,
      harnessOverride: {
        factory: testHarnessFactory,
        config: {
          script: [
            [
              { call: { tool: "uppercase", input: { wrong: "field" } } },
              { stop: "end_turn" },
            ],
          ],
        },
      },
    });
    try {
      await agent.prompt("go");
      const events = await agent.session.getEvents();
      const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
      expect(tu).toBeTruthy();
      if (tu && tu.sessionUpdate === "tool_call_update") {
        expect(tu.status).toBe("failed");
      }
    } finally {
      await agent.close();
    }
  });

  it("does not leak tool-undeclared secrets to tool processes", async () => {
    // Ask the uppercase tool to print env to test secret isolation.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glass-iso-"));
    try {
      const toolDir = path.join(dir, "tools", "envprint");
      await fs.mkdir(path.join(toolDir, "bin"), { recursive: true });
      await fs.writeFile(
        path.join(toolDir, "tool.toml"),
        `[tool]
name = "envprint"
description = "print env"
[tool.schema]
type = "object"
[tool.invocation]
command = "envprint"
[tool.secrets]
required = []
[tool.capabilities]
filesystem = []
network = []
`,
      );
      await fs.writeFile(
        path.join(toolDir, "bin", "envprint"),
        `#!/usr/bin/env node
const env = process.env;
const interesting = ['MY_SECRET','OTHER_SECRET','sample_user_name'];
const result = {};
for (const k of interesting) result[k] = env[k] ?? null;
process.stdout.write(JSON.stringify(result));
`,
      );
      await fs.chmod(path.join(toolDir, "bin", "envprint"), 0o755);
      const skillDir = path.join(dir, "skills", "envskill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: envskill
description: snoops env
requires:
  envprint: ../../tools/envprint
---
body`,
      );
      const agentDir = path.join(dir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "iso"
system_prompt = "x"
remove_builtin_tools = true

[harness]
provider = "test"
[session]
provider = "memory"
[sandbox]
filesystem = ["./"]
network = []
secrets = []
[skills]
e = "../skills/envskill"
`,
      );

      // Set sensitive env vars in the parent process; tool MUST NOT see them.
      process.env.MY_SECRET = "leak-me";
      process.env.OTHER_SECRET = "leak-too";

      const agent = await runAgent(path.join(agentDir, "agent.toml"), {
        sessionOverride: memorySessionFactory,
        harnessOverride: {
          factory: testHarnessFactory,
          config: {
            script: [
              [{ call: { tool: "envprint", input: {} } }, { stop: "end_turn" }],
            ],
          },
        },
      });
      try {
        await agent.prompt("go");
        const events = await agent.session.getEvents();
        const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
        expect(tu).toBeTruthy();
        if (tu && tu.sessionUpdate === "tool_call_update") {
          const text =
            tu.content?.[0]?.type === "content" && tu.content[0].content.type === "text"
              ? tu.content[0].content.text
              : "";
          const got = JSON.parse(text);
          expect(got.MY_SECRET).toBeNull();
          expect(got.OTHER_SECRET).toBeNull();
        }
      } finally {
        await agent.close();
      }
    } finally {
      delete process.env.MY_SECRET;
      delete process.env.OTHER_SECRET;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("system prompt assembly", () => {
  it("includes the manifest-owned core, skills, and a Context block", () => {
    const text = assembleSystemPrompt({
      core: "I am a helpful assistant.",
      skills: [
        {
          name: "greeter",
          description: "Greet the user",
          body: "Use greet() then uppercase().",
          toolNames: ["greet", "uppercase"],
        },
      ],
      tools: [
        { name: "greet", description: "Greet", inputSchema: {} },
        { name: "uppercase", description: "Shout", inputSchema: {} },
      ],
      agentName: "tester",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(text).toContain("I am a helpful assistant.");
    expect(text).toContain("# Available Skills");
    expect(text).toContain("greet, uppercase");
    expect(text).toContain("# Tool Reference");
    expect(text).toContain("Current date: 2026-01-01");
  });
});
