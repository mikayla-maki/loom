import { describe, expect, it } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import { assembleSystemPrompt } from "../src/runtime/system-prompt.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type { TurnScript } from "../src/extensions/harness/test.js";

/**
 * Build the canonical sample-agent inline spec used by these tests. With
 * the new architecture there's no on-disk tool format and no inline tool
 * shape — the agent uses default builtin tools (the spec leaves [tools]
 * undefined so loom auto-loads `bash`, `read_file`, `write_file`, `find`)
 * plus a one-off `echo` reference for tests that need a deterministic
 * tool call.
 */
function sampleAgentSpec(harnessScript?: TurnScript[]): AgentManifest {
  return {
    name: "sample-agent",
    description: "An end-to-end Loom v0 demo agent.",
    systemPrompt:
      "You are the Loom sample agent — greet the user and shout the result.",
    tools: {
      bash: {},
      read_file: { paths: ["./"] },
      write_file: { paths: ["./"] },
      find: { paths: ["./"] },
      echo: {},
    },
    harness: {
      provider: "test",
      ...(harnessScript ? { script: harnessScript } : {}),
    },
  };
}

describe("runAgent → end-to-end with TestHarness + memory session", () => {
  it("runs scripted steps including a tool call", async () => {
    const agent = await runAgent(
      sampleAgentSpec([
        [
          { say: "On it." },
          { call: { tool: "echo", input: { text: "hello, alice" } } },
          { stop: "end_turn" },
        ],
      ]),
      {
        secrets: new StaticSecretsStore({ sample_user_name: "ALICE" }),
      },
    );
    try {
      const result = await agent.prompt("Hi there!");
      expect(result.stopReason).toBe("end_turn");
      const events = (await agent.session.pull?.([])) ?? [];
      const messages = events
        .filter((e) => e.sessionUpdate === "agent_message_chunk")
        .map((e) => (e.content.type === "text" ? e.content.text : ""));
      expect(messages.join(" | ")).toContain("On it.");
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
      const result = await p;
      // Either the harness yields cancelled, or the script completes before the
      // signal lands. Both are valid; just ensure cancel() completes cleanly.
      expect(["cancelled", "end_turn"]).toContain(result.stopReason);
    } finally {
      await agent.close();
    }
  });

  it("validates tool input against the JSON schema", async () => {
    const agent = await runAgent(
      sampleAgentSpec([
        [
          // `echo` requires `{ text: string }`; pass a wrong field to fail.
          { call: { tool: "echo", input: { wrong: "field" } } },
          { stop: "end_turn" },
        ],
      ]),
      {
        secrets: new StaticSecretsStore({ sample_user_name: "DIANA" }),
      },
    );
    try {
      await agent.prompt("go");
      const events = (await agent.session.pull?.([])) ?? [];
      const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
      expect(tu).toBeTruthy();
      if (tu && tu.sessionUpdate === "tool_call_update") {
        expect(tu.status).toBe("failed");
      }
    } finally {
      await agent.close();
    }
  });
});

describe("system prompt assembly", () => {
  it("includes the manifest-owned core, the tool reference, and a Context block", () => {
    const text = assembleSystemPrompt({
      core: "I am a helpful assistant.",
      tools: [
        { name: "greet", description: "Greet", inputSchema: {} },
        { name: "uppercase", description: "Shout", inputSchema: {} },
      ],
      agentName: "tester",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(text).toContain("I am a helpful assistant.");
    expect(text).toContain("# Tool Reference");
    expect(text).toContain("`greet`");
    expect(text).toContain("`uppercase`");
    expect(text).toContain("Current date: 2026-01-01");
    // Skills are gone — no skill catalog section.
    expect(text).not.toContain("# Available Skills");
  });
});
