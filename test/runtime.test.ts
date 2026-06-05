import { describe, expect, it } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import { assembleSystemPrompt } from "../src/runtime/system-prompt.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type { TurnScript, TurnStep } from "../src/builtins/harness/test.js";
import type { Runtime } from "../src/types/interfaces.js";
import { echoTestProvider } from "./fixtures/echo-tool.js";

// Either per-turn scripts, or a function that produces a turn's steps (used
// to drive timing-sensitive paths like cancellation).
type HarnessScript = TurnScript[] | ((runtime: Runtime) => Promise<TurnStep[]>);

function sampleAgentSpec(harnessScript?: HarnessScript): AgentManifest {
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

// The sample agent never reads its secret, so the user name is irrelevant
// to behavior — any value works.
function startAgent(harnessScript?: HarnessScript) {
  return runAgent(sampleAgentSpec(harnessScript), {
    secrets: new StaticSecretsStore({ sample_user_name: "TESTER" }),
    providers: [echoTestProvider],
  });
}

type AgentSession = Awaited<ReturnType<typeof startAgent>>["session"];

async function agentMessages(session: AgentSession): Promise<string[]> {
  const events = (await session.pull?.([])) ?? [];
  return events
    .filter((e) => e.sessionUpdate === "agent_message_chunk")
    .map((e) => (e.content.type === "text" ? e.content.text : ""));
}

async function toolStatus(session: AgentSession): Promise<string | undefined> {
  const events = (await session.pull?.([])) ?? [];
  const tool = events.find((e) => e.sessionUpdate === "tool_call_update");
  return tool?.sessionUpdate === "tool_call_update" ? tool.status : undefined;
}

describe("runAgent → end-to-end with TestHarness + memory session", () => {
  it("runs scripted steps including a tool call", async () => {
    const agent = await startAgent([
      [
        { say: "On it." },
        { call: { tool: "echo", input: { text: "hello, alice" } } },
        { stop: "end_turn" },
      ],
    ]);
    try {
      const result = await agent.prompt("Hi there!");
      expect(result.stopReason).toBe("end_turn");
      const messages = await agentMessages(agent.session);
      expect(messages.join(" | ")).toContain("On it.");
      expect(await toolStatus(agent.session)).toBe("completed");
    } finally {
      await agent.close();
    }
  });

  it("emits live updates to subscribers", async () => {
    const agent = await startAgent([[{ say: "ack" }, { stop: "end_turn" }]]);
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
    // Block the turn until the abort fires, then return steps that must
    // never run. If cancel() were a no-op the abort would never resolve and
    // the test would time out, so this only passes when cancellation works.
    const script: TurnScript = async (rt: Runtime) => {
      await new Promise<void>((resolve) => {
        if (rt.abortSignal.aborted) return resolve();
        rt.abortSignal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      const out: TurnScript[number][] = [];
      for (let i = 0; i < 50; i++) out.push({ say: `step ${i}` });
      out.push({ stop: "end_turn" });
      return out;
    };
    const agent = await startAgent(script as unknown as TurnScript[]);
    try {
      const p = agent.prompt("go");
      setTimeout(() => agent.cancel(), 5);
      const result = await p;
      expect(result.stopReason).toBe("cancelled");
      const messages = await agentMessages(agent.session);
      expect(messages.some((m) => m.startsWith("step "))).toBe(false);
    } finally {
      await agent.close();
    }
  });

  it("validates tool input against the JSON schema", async () => {
    const agent = await startAgent([
      [
        { call: { tool: "echo", input: { wrong: "field" } } },
        { stop: "end_turn" },
      ],
    ]);
    try {
      await agent.prompt("go");
      expect(await toolStatus(agent.session)).toBe("failed");
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
