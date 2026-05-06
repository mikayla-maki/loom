import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { runAgent } from "../src/sdk/run-agent.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import { assembleSystemPrompt } from "../src/runtime/system-prompt.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type { TurnScript } from "../src/extensions/harness/test.js";

const FIXTURES = path.resolve("test/fixtures");
const GREET_BIN = path.join(FIXTURES, "tools/whoami/bin/sample-greet");
const UPPERCASE_BIN = path.join(
  FIXTURES,
  "tools/uppercase/bin/sample-uppercase",
);

/** Build the canonical sample-agent inline spec used by these tests. */
function sampleAgentSpec(harnessScript?: TurnScript[]): AgentManifest {
  return {
    name: "sample-agent",
    description: "An end-to-end Loom v0 demo agent.",
    systemPrompt:
      "You are the Loom sample agent — greet the user and shout the result.",
    removeBuiltinTools: true,
    harness: {
      provider: "test",
      ...(harnessScript ? { script: harnessScript } : {}),
    },
    sandbox: {
      filesystem: ["./"],
      network: [],
      secrets: ["sample_user_name"],
    },
    skills: {
      greeter: {
        description: "Greet the user by name and shout the greeting.",
        body: "Use `greet` then `uppercase`.",
        requires: {
          greet: {
            description:
              "Build a greeting using the user's name (read from secrets).",
            schema: {
              type: "object",
              required: ["greeting"],
              properties: { greeting: { type: "string" } },
            },
            invocation: { command: GREET_BIN },
            secrets: { required: ["sample_user_name"] },
            capabilities: {
              filesystem: [],
              network: [],
              secrets: ["sample_user_name"],
            },
          },
          uppercase: {
            description: "Uppercase a string.",
            schema: {
              type: "object",
              required: ["text"],
              properties: { text: { type: "string" } },
            },
            invocation: { command: UPPERCASE_BIN },
            capabilities: { filesystem: [], network: [] },
          },
        },
      },
    },
  };
}

describe("runAgent → end-to-end with TestHarness + memory session", () => {
  it("runs scripted steps including a tool call", async () => {
    const agent = await runAgent(
      sampleAgentSpec([
        [
          { say: "On it." },
          { call: { tool: "greet", input: { greeting: "hello" } } },
          { stop: "end_turn" },
        ],
      ]),
      {
        secrets: new StaticSecretsStore({ sample_user_name: "ALICE" }),
      },
    );
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
    const agent = await runAgent(
      sampleAgentSpec([[{ say: "ack" }, { stop: "end_turn" }]]),
      {
        secrets: new StaticSecretsStore({ sample_user_name: "BOB" }),
      },
    );
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
    const spec = sampleAgentSpec();
    // Long script, but harness checks abortSignal between steps. Use
    // the function form for `script` (configured inline on the harness).
    if ("provider" in spec.harness) {
      spec.harness.script = async (rt: unknown) => {
        const out = [{ say: "starting" }] as Array<
          | { say: string }
          | { call: { tool: string; input: unknown } }
          | { stop: "end_turn" | "cancelled" }
        >;
        for (let i = 0; i < 50; i++) out.push({ say: `step ${i}` });
        // Force a yield so the abort can land.
        await new Promise((resolve) => setTimeout(resolve, 10));
        void rt;
        out.push({ stop: "end_turn" });
        return out;
      };
    }
    const agent = await runAgent(spec, {
      secrets: new StaticSecretsStore({ sample_user_name: "CARL" }),
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
    const agent = await runAgent(
      sampleAgentSpec([
        [
          { call: { tool: "uppercase", input: { wrong: "field" } } },
          { stop: "end_turn" },
        ],
      ]),
      {
        secrets: new StaticSecretsStore({ sample_user_name: "DIANA" }),
      },
    );
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
    // A small ad-hoc envprint script lives on disk (executable bit
    // matters), but the agent/skill/tool are declared inline.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-iso-"));
    try {
      const envprintPath = path.join(dir, "envprint");
      await fs.writeFile(
        envprintPath,
        `#!/usr/bin/env node
const env = process.env;
const interesting = ['MY_SECRET','OTHER_SECRET','sample_user_name'];
const result = {};
for (const k of interesting) result[k] = env[k] ?? null;
process.stdout.write(JSON.stringify(result));
`,
      );
      await fs.chmod(envprintPath, 0o755);

      const spec: AgentManifest = {
        name: "iso",
        systemPrompt: "x",
        removeBuiltinTools: true,
        harness: {
          provider: "test",
          script: [
            [{ call: { tool: "envprint", input: {} } }, { stop: "end_turn" }],
          ],
        },
        sandbox: { filesystem: ["./"], network: [], secrets: [] },
        skills: {
          envskill: {
            description: "snoops env",
            requires: {
              envprint: {
                description: "print env",
                schema: { type: "object" },
                invocation: { command: envprintPath },
                capabilities: { filesystem: [], network: [] },
              },
            },
          },
        },
      };

      // Set sensitive env vars in the parent process; tool MUST NOT see them.
      process.env.MY_SECRET = "leak-me";
      process.env.OTHER_SECRET = "leak-too";

      const agent = await runAgent(spec, {});
      try {
        await agent.prompt("go");
        const events = await agent.session.getEvents();
        const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
        expect(tu).toBeTruthy();
        if (tu && tu.sessionUpdate === "tool_call_update") {
          const text =
            tu.content?.[0]?.type === "content" &&
            tu.content[0].content.type === "text"
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
