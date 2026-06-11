/**
 * The embedder surface: lifecycle framing, ephemeral tool progress,
 * lossless update subscriptions, and mid-turn steering. These are the
 * primitives a host (e.g. a coding-agent CLI) needs to rebuild its own
 * event model on top of Loom's update stream.
 */

import { describe, expect, it } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import type { RunningAgent } from "../src/sdk/running-agent.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type { FrameUpdate, SessionUpdate } from "../src/types/acp.js";
import type { Harness, Runtime, TurnResult } from "../src/types/interfaces.js";
import type { TurnScript } from "../src/builtins/harness/test.js";
import { echoTestProvider } from "./fixtures/echo-tool.js";
import { instrumentedToolsProvider } from "./fixtures/instrumented-tools.js";

function manifest(script: TurnScript[]): AgentManifest {
  return {
    name: "embedder-agent",
    systemPrompt: "Test agent.",
    tools: {
      echo: "builtin",
      ticker: "builtin",
      trigger: "builtin",
    },
    capabilities: {
      echo: "*",
      ticker: "*",
      trigger: "*",
    },
    harness: { provider: "test", script },
  };
}

function providers(hooks: { onTrigger?: () => void } = {}) {
  return [echoTestProvider, instrumentedToolsProvider(hooks)];
}

function summarize(u: SessionUpdate): string {
  switch (u.sessionUpdate) {
    case "frame":
      return `frame:${u.frame}${u.role ? `:${u.role}` : ""}`;
    case "user_message_chunk":
      return `user:${u.content.type === "text" ? u.content.text : "?"}`;
    case "agent_message_chunk":
      return `agent:${u.content.type === "text" ? u.content.text : "?"}`;
    case "agent_thought_chunk":
      return `thought:${u.content.type === "text" ? u.content.text : "?"}`;
    case "tool_call":
      return `tool_call:${u.title}`;
    case "tool_call_update": {
      const text = (u.content ?? [])
        .map((c) =>
          c.type === "content" && c.content.type === "text"
            ? c.content.text
            : "",
        )
        .join("");
      return `tool_update:${u.status ?? "in_progress"}:${text}`;
    }
    case "stop":
      return `stop:${u.stopReason}`;
    default:
      return u.sessionUpdate;
  }
}

/** Subscribe before prompting; collect everything through the turn_end frame. */
function collectTurn(agent: RunningAgent): {
  done: Promise<SessionUpdate[]>;
} {
  const sub = agent.updates({ capacity: "unbounded" });
  const done = (async () => {
    const seen: SessionUpdate[] = [];
    for await (const u of sub) {
      seen.push(u);
      if (u.sessionUpdate === "frame" && u.frame === "turn_end") break;
    }
    return seen;
  })();
  return { done };
}

async function sessionTranscript(agent: RunningAgent): Promise<string[]> {
  const events = (await agent.session.pull?.([])) ?? [];
  return events.map(summarize);
}

describe("lifecycle framing", () => {
  it("frames the turn, the user message, and assistant messages around tool calls", async () => {
    const agent = await runAgent(
      manifest([
        [
          { say: "On it." },
          { call: { tool: "echo", input: { text: "hello" } } },
          { stop: "end_turn" },
        ],
      ]),
      { providers: providers() },
    );
    const { done } = collectTurn(agent);
    try {
      await agent.prompt("go");
      const seen = (await done).map(summarize);
      expect(seen).toEqual([
        "frame:turn_start",
        "frame:message_start:user",
        "user:go",
        "frame:message_end:user",
        "frame:message_start:assistant",
        "agent:On it.",
        "tool_call:echo",
        // The barrier: the assistant message closes before its tool runs.
        "frame:message_end:assistant",
        "tool_update:completed:hello",
        "frame:message_start:assistant",
        "agent:hello",
        "frame:message_end:assistant",
        "stop:end_turn",
        "frame:turn_end",
      ]);
    } finally {
      await agent.close();
    }
  });

  it("correlates chunks to messages via messageId and never persists frames", async () => {
    const agent = await runAgent(
      manifest([[{ say: "hi" }, { stop: "end_turn" }]]),
      { providers: providers() },
    );
    const { done } = collectTurn(agent);
    try {
      await agent.prompt("go");
      const seen = await done;
      const frames = seen.filter(
        (u): u is FrameUpdate => u.sessionUpdate === "frame",
      );
      const ids = frames.map((f) => f.messageId);
      // turn frames carry no id; each message's start/end share one.
      expect(frames.map((f) => f.frame)).toEqual([
        "turn_start",
        "message_start",
        "message_end",
        "message_start",
        "message_end",
        "turn_end",
      ]);
      expect(ids[0]).toBeUndefined();
      expect(ids[5]).toBeUndefined();
      expect(ids[1]).toBeDefined();
      expect(ids[1]).toBe(ids[2]);
      expect(ids[3]).toBeDefined();
      expect(ids[3]).toBe(ids[4]);
      expect(ids[1]).not.toBe(ids[3]);

      expect(await sessionTranscript(agent)).toEqual([
        "user:go",
        "agent:hi",
        "stop:end_turn",
      ]);
    } finally {
      await agent.close();
    }
  });
});

describe("tool progress", () => {
  it("streams in_progress updates to subscribers but never to the session", async () => {
    const agent = await runAgent(
      manifest([
        [
          { call: { tool: "ticker", input: {} }, surface: false },
          { stop: "end_turn" },
        ],
      ]),
      { providers: providers() },
    );
    const { done } = collectTurn(agent);
    try {
      await agent.prompt("go");
      const seen = (await done).map(summarize);
      expect(seen).toEqual([
        "frame:turn_start",
        "frame:message_start:user",
        "user:go",
        "frame:message_end:user",
        "frame:message_start:assistant",
        "tool_call:ticker",
        "frame:message_end:assistant",
        "tool_update:in_progress:tick 1",
        "tool_update:in_progress:tick 2",
        "tool_update:completed:done",
        "stop:end_turn",
        "frame:turn_end",
      ]);
      expect(await sessionTranscript(agent)).toEqual([
        "user:go",
        "tool_call:ticker",
        "tool_update:completed:done",
        "stop:end_turn",
      ]);
    } finally {
      await agent.close();
    }
  });
});

describe("lossless subscription", () => {
  it("an unconsumed bounded subscriber drops oldest; unbounded retains all", async () => {
    const script: TurnScript[] = [
      [
        { say: "1" },
        { say: "2" },
        { say: "3" },
        { say: "4" },
        { say: "5" },
        { stop: "end_turn" },
      ],
    ];
    const agent = await runAgent(manifest(script), {
      providers: providers(),
    });
    const bounded = agent.updates({ capacity: 3 });
    const unbounded = agent.updates({ capacity: "unbounded" });
    try {
      await agent.prompt("go");
    } finally {
      await agent.close();
    }
    const drain = async (
      sub: AsyncIterableIterator<SessionUpdate>,
    ): Promise<string[]> => {
      const out: string[] = [];
      for await (const u of sub) out.push(summarize(u));
      return out;
    };
    const all = await drain(unbounded);
    expect(all).toEqual([
      "frame:turn_start",
      "frame:message_start:user",
      "user:go",
      "frame:message_end:user",
      "frame:message_start:assistant",
      "agent:1",
      "agent:2",
      "agent:3",
      "agent:4",
      "agent:5",
      "frame:message_end:assistant",
      "stop:end_turn",
      "frame:turn_end",
    ]);
    expect(await drain(bounded)).toEqual(all.slice(-3));
  });
});

describe("steering", () => {
  it("injects mid-turn after the tool batch, in order, into both stream and session", async () => {
    let agentRef: RunningAgent | null = null;
    const agent = await runAgent(
      manifest([
        [
          { say: "working" },
          { call: { tool: "trigger", input: {} } },
          { say: "after" },
          { stop: "end_turn" },
        ],
      ]),
      {
        providers: providers({
          onTrigger: () => agentRef?.steer("change of plans"),
        }),
      },
    );
    agentRef = agent;
    const { done } = collectTurn(agent);
    try {
      await agent.prompt("go");
      const seen = (await done).map(summarize);
      expect(seen).toEqual([
        "frame:turn_start",
        "frame:message_start:user",
        "user:go",
        "frame:message_end:user",
        "frame:message_start:assistant",
        "agent:working",
        "tool_call:trigger",
        "frame:message_end:assistant",
        "tool_update:completed:triggered",
        // The steered message lands after the tool batch, before any
        // follow-up assistant content.
        "frame:message_start:user",
        "user:change of plans",
        "frame:message_end:user",
        "frame:message_start:assistant",
        "agent:triggered",
        "agent:after",
        "frame:message_end:assistant",
        "stop:end_turn",
        "frame:turn_end",
      ]);
      expect(await sessionTranscript(agent)).toEqual([
        "user:go",
        "agent:working",
        "tool_call:trigger",
        "tool_update:completed:triggered",
        "user:change of plans",
        "agent:triggered",
        "agent:after",
        "stop:end_turn",
      ]);
    } finally {
      await agent.close();
    }
  });

  it("drains steering queued while idle at the start of the next turn", async () => {
    const agent = await runAgent(
      manifest([[{ say: "ok" }, { stop: "end_turn" }]]),
      { providers: providers() },
    );
    try {
      agent.steer("psst");
      await agent.prompt("go");
      expect(await sessionTranscript(agent)).toEqual([
        "user:go",
        "user:psst",
        "agent:ok",
        "stop:end_turn",
      ]);
    } finally {
      await agent.close();
    }
  });

  it("throws when the harness does not implement steer", async () => {
    const inert: Harness = {
      async run(runtime: Runtime): Promise<TurnResult> {
        await runtime.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return { stopReason: "end_turn" };
      },
    };
    const agent = await runAgent({
      name: "inert-agent",
      systemPrompt: "Test agent.",
      harness: inert,
      tools: {},
      capabilities: {},
    });
    try {
      expect(() => agent.steer("hello")).toThrowError(/does not support/);
    } finally {
      await agent.close();
    }
  });
});
