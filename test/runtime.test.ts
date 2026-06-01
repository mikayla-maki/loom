import { describe, expect, it } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import { assembleSystemPrompt } from "../src/runtime/system-prompt.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type { TurnScript } from "../src/builtins/harness/test.js";
import type { Runtime } from "../src/types/interfaces.js";
import { echoTestProvider } from "./fixtures/echo-tool.js";

function sampleAgentSpec(harnessScript?: TurnScript[]): AgentManifest {
  return {
    name: "sample-agent",
    description: "An end-to-end Loom v0 demo agent.",
    systemPrompt:
      "You are the Loom sample agent — greet the user and shout the result.",
    tools: {
      bash: "builtin",
      read_file: "builtin",
      write_file: "builtin",
      edit_file: "builtin",
      echo: "builtin",
    },
    capabilities: {
      bash: { commands: "*", paths: ["./"] },
      read_file: { paths: ["./"] },
      write_file: { paths: ["./"] },
      edit_file: { paths: ["./"] },
      echo: "*",
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
        providers: [echoTestProvider],
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
        providers: [echoTestProvider],
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
    if ("provider" in spec.harness) {
      // Block the turn until cancellation actually fires, then hand back
      // steps that must never run because the abort already tripped.
      // If cancel() is a no-op the abort never resolves and the test
      // times out — so this only passes when cancellation truly works.
      spec.harness.script = async (rt: Runtime) => {
        await new Promise<void>((resolve) => {
          if (rt.abortSignal.aborted) {
            resolve();
            return;
          }
          rt.abortSignal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        const out = [] as Array<
          | { say: string }
          | { call: { tool: string; input: unknown } }
          | { stop: "end_turn" | "cancelled" }
        >;
        for (let i = 0; i < 50; i++) out.push({ say: `step ${i}` });
        out.push({ stop: "end_turn" });
        return out;
      };
    }
    const agent = await runAgent(spec, {
      secrets: new StaticSecretsStore({ sample_user_name: "CARL" }),
      providers: [echoTestProvider],
    });
    try {
      const p = agent.prompt("go");
      setTimeout(() => agent.cancel(), 5);
      const result = await p;
      expect(result.stopReason).toBe("cancelled");
      const events = (await agent.session.pull?.([])) ?? [];
      const messages = events
        .filter((e) => e.sessionUpdate === "agent_message_chunk")
        .map((e) => (e.content.type === "text" ? e.content.text : ""));
      // The post-cancel "step N" chunks must not have been emitted.
      expect(messages.some((m) => m.startsWith("step "))).toBe(false);
    } finally {
      await agent.close();
    }
  });

  it("validates tool input against the JSON schema", async () => {
    const agent = await runAgent(
      sampleAgentSpec([
        [
          { call: { tool: "echo", input: { wrong: "field" } } },
          { stop: "end_turn" },
        ],
      ]),
      {
        secrets: new StaticSecretsStore({ sample_user_name: "DIANA" }),
        providers: [echoTestProvider],
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
  const inputs = {
    core: "I am a helpful assistant.",
    tools: [
      { name: "greet", description: "Greet", inputSchema: {} },
      { name: "uppercase", description: "Shout", inputSchema: {} },
    ],
    agentName: "tester",
  };

  it("includes the core and tool reference, omits ambient context, and is byte-stable", () => {
    const text = assembleSystemPrompt(inputs);
    expect(text).toContain("I am a helpful assistant.");
    expect(text).toContain("# Tool Reference");
    expect(text).toContain("`greet`");
    expect(text).toContain("`uppercase`");
    expect(text).not.toContain("# Available Skills");
    expect(text).not.toContain("# Context");
    expect(text).not.toContain("Current date");
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(assembleSystemPrompt(inputs)).toBe(text);
  });
});
