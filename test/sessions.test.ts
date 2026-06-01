import { describe, expect, it } from "vitest";

import {
  CompactingSession,
  compactingMemorySession,
} from "../src/builtins/session/compacting.js";
import { ChainedSession } from "../src/runtime/session-chain.js";
import { InMemorySession } from "../src/builtins/session/memory.js";
import { runAgent } from "../src/sdk/run-agent.js";
import type { TurnStep } from "../src/builtins/harness/test.js";
import type {
  Agent,
  Runtime,
  Session,
  ToolRef,
} from "../src/types/interfaces.js";
import type { SessionUpdate } from "../src/types/acp.js";
import { echoTestProvider } from "./fixtures/echo-tool.js";

function userMsg(text: string): SessionUpdate {
  return {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text },
  };
}
function agentMsg(text: string): SessionUpdate {
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  };
}

describe("Session push/pull semantics", () => {
  it("treats absent push/pull as passthrough at the chain level", async () => {
    const promptOnly: Session = {
      systemPromptSection: () => "# Custom Section",
    };
    const log = new InMemorySession();
    const chained = new ChainedSession([log, promptOnly]);

    await chained.push(userMsg("hello"));
    await chained.push(agentMsg("hi back"));

    const events = await chained.pull([]);
    expect(events).toHaveLength(2);
    expect(events[0]?.sessionUpdate).toBe("user_message_chunk");
    expect(events[1]?.sessionUpdate).toBe("agent_message_chunk");
  });

  it("lets a push hook fan one event into many", async () => {
    const fanout: Session = {
      async push(event) {
        if (event.sessionUpdate === "user_message_chunk") {
          return [
            event,
            {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "[fanned]" },
            },
          ];
        }
        return [event];
      },
    };
    const log = new InMemorySession();
    const chained = new ChainedSession([fanout, log]);

    await chained.push(userMsg("test"));
    const events = await chained.pull([]);
    expect(events).toHaveLength(2);
    expect(events[0]?.sessionUpdate).toBe("user_message_chunk");
    expect(events[1]?.sessionUpdate).toBe("agent_thought_chunk");
  });

  it("lets a push hook return [] to drop an event before downstream", async () => {
    const redactor: Session = {
      async push(event) {
        if (event.sessionUpdate === "user_message_chunk") return [];
        return [event];
      },
    };
    const log = new InMemorySession();
    const chained = new ChainedSession([redactor, log]);

    await chained.push(userMsg("secret"));
    await chained.push(agentMsg("public"));

    const events = await chained.pull([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.sessionUpdate).toBe("agent_message_chunk");
  });

  it("lets a leaf session replace upstream events on pull", async () => {
    const log = new InMemorySession();
    const doubler: Session = {
      async pull(below) {
        const out: SessionUpdate[] = [];
        for (const e of below) out.push(e, e);
        return out;
      },
    };
    const prefixer: Session = {
      async pull(below) {
        return [
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "[prefix]" },
          },
          ...below,
        ];
      },
    };

    const chained = new ChainedSession([log, doubler, prefixer]);
    await chained.push(userMsg("a"));

    const events = await chained.pull([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.sessionUpdate).toBe("user_message_chunk");
  });

  it("composes pull transformers top-to-bottom over passthrough leaves", async () => {
    const passthroughLeaf: Session = {
      async pull(below) {
        return below;
      },
    };
    const doubler: Session = {
      async pull(below) {
        const out: SessionUpdate[] = [];
        for (const e of below) out.push(e, e);
        return out;
      },
    };
    const prefixer: Session = {
      async pull(below) {
        return [
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "[prefix]" },
          },
          ...below,
        ];
      },
    };

    const chained = new ChainedSession([passthroughLeaf, doubler, prefixer]);
    const events = await chained.pull([userMsg("a"), userMsg("b")]);
    expect(events).toHaveLength(6);
  });

  it("composes prepareTurn, systemPromptSection, tools, and dependencies", async () => {
    const calls: string[] = [];

    const a: Session = {
      async prepareTurn() {
        calls.push("a:prepare");
      },
      systemPromptSection: () => "section A",
      tools: () => [{ name: "tool_a", config: {} }],
      dependencies: {
        subagents: [{ name: "sub-a", harness: { provider: "test" } }],
      },
    };
    const b: Session = {
      async prepareTurn() {
        calls.push("b:prepare");
      },
      systemPromptSection: () => "section B",
      tools: () => [{ name: "tool_b", config: {} }],
      dependencies: {
        subagents: [{ name: "sub-b", harness: { provider: "test" } }],
      },
    };
    const chained = new ChainedSession([a, b]);

    const fakeAgent: Agent = {
      manifest: { name: "x", harness: { provider: "test" } },
      harness: { run: async () => ({ stopReason: "end_turn" as const }) },
      session: chained,
      systemPromptCore: "x",
    };

    await chained.prepareTurn?.(fakeAgent);
    expect(calls).toEqual(["a:prepare", "b:prepare"]);

    const section = await chained.systemPromptSection?.(fakeAgent);
    expect(section).toBe("section A\n\nsection B");

    const tools = (await chained.tools?.()) as ToolRef[];
    expect(tools.map((t) => t.name)).toEqual(["tool_a", "tool_b"]);

    const subs = chained.dependencies?.subagents ?? [];
    expect(subs.map((m) => m.name)).toEqual(["sub-a", "sub-b"]);
  });

  it("closes in declaration order", async () => {
    const closed: string[] = [];
    const a: Session = { close: async () => void closed.push("a") };
    const b: Session = { close: async () => void closed.push("b") };
    const chained = new ChainedSession([a, b]);
    await chained.close?.();
    expect(closed).toEqual(["a", "b"]);
  });
});

describe("CompactingSession (chain transform)", () => {
  it("passes pushed events to storage, caches summaries to shrink the pull view, and keeps usage updates out of storage", async () => {
    const memory = new InMemorySession();
    const compactor = new CompactingSession({ threshold: 100, keep: 2 });
    const session = new ChainedSession([compactor, memory]);

    for (let i = 0; i < 8; i++) {
      await session.push(i % 2 === 0 ? userMsg(`u${i}`) : agentMsg(`a${i}`));
    }
    await session.push({
      sessionUpdate: "usage_update",
      used: 1234,
      size: 200000,
    });

    expect(await memory.pull([])).toHaveLength(8);
    expect(await session.pull([])).toHaveLength(8);
    expect(compactor.tokensInContext).toBe(1234);
    expect(compactor.contextWindow).toBe(200000);

    await compactor.compactNow();

    expect(await session.pull([])).toHaveLength(4);
    expect(await memory.pull([])).toHaveLength(8);
  });
});

describe("Convenience builders", () => {
  it("compactingMemorySession returns a composed chain wrapper", async () => {
    const s = compactingMemorySession({ threshold: 5, keep: 2 });
    expect(s).toBeInstanceOf(ChainedSession);
    expect(s).not.toBeInstanceOf(CompactingSession);
    await s.push?.(userMsg("test"));
    const events = (await s.pull?.([])) ?? [];
    expect(events).toHaveLength(1);
  });
});

describe("End-to-end: ChainedSession through runAgent", () => {
  it("boots an agent on a chained session that can read context", async () => {
    let captured: string | null = null;
    const agent = await runAgent({
      name: "chained-agent",
      systemPrompt: "hi",
      tools: {},
      harness: {
        provider: "test",
        script: async (rt: Runtime) => {
          const events = await rt.getEvents();
          captured = events
            .map((e: SessionUpdate) =>
              e.sessionUpdate === "user_message_chunk" &&
              e.content.type === "text"
                ? e.content.text
                : "",
            )
            .join("|");
          return [{ stop: "end_turn" }];
        },
      },
      session: new ChainedSession([new InMemorySession()]),
    });
    try {
      await agent.prompt("hello world");
      expect(captured).toBe("hello world");
    } finally {
      await agent.close();
    }
  });

  it("assembles a manifest-form SessionSpec[] chain that actually compacts", async () => {
    const turns: TurnStep[][] = [];
    for (let i = 0; i < 6; i++)
      turns.push([{ say: "ack" }, { stop: "end_turn" }]);
    const agent = await runAgent({
      name: "chain-runs",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test", script: turns },
      session: [
        { provider: "compacting", threshold: 6, keep: 2 },
        { provider: "in-memory" },
      ],
    });
    try {
      for (let i = 0; i < 6; i++) await agent.prompt(`p${i}`);
      const events = (await agent.session.pull?.([])) ?? [];
      const first = events[0];
      if (
        first &&
        first.sessionUpdate === "user_message_chunk" &&
        first.content.type === "text"
      ) {
        expect(first.content.text).toMatch(/summary/i);
      } else {
        throw new Error("expected first event to be the synthetic summary");
      }
    } finally {
      await agent.close();
    }
  });

  it("honours manifest-form chain order: push outer-to-inner, pull inner-to-outer", async () => {
    const order: string[] = [];
    const layerA: Session = {
      async push(e) {
        order.push("A:push");
        return [e];
      },
      async pull(below) {
        order.push("A:pull");
        return below;
      },
    };
    const layerB: Session = {
      async push(e) {
        order.push("B:push");
        return [e];
      },
      async pull(below) {
        order.push("B:pull");
        return below;
      },
    };
    const chain = new ChainedSession([layerA, layerB, new InMemorySession()]);
    await chain.push(userMsg("hi"));
    await chain.pull([]);
    expect(order.filter((s) => s.startsWith("A"))).toEqual([
      "A:push",
      "A:pull",
    ]);
    expect(order.filter((s) => s.startsWith("B"))).toEqual([
      "B:push",
      "B:pull",
    ]);
    expect(order.indexOf("A:push")).toBeLessThan(order.indexOf("B:push"));
    expect(order.indexOf("B:pull")).toBeLessThan(order.indexOf("A:pull"));
  });

  it("registers tools contributed by a session via tools() at boot", async () => {
    const sessionWithTool: Session = {
      tools: () => [{ name: "echo", config: {} }],
    };
    const agent = await runAgent(
      {
        name: "session-tools",
        systemPrompt: "x",
        tools: {},
        capabilities: { echo: "*" },
        harness: { provider: "test" },
        session: sessionWithTool,
      },
      { providers: [echoTestProvider] },
    );
    try {
      const tools = agent.agentState.toolTable.list().map((t) => t.name);
      expect(tools).toContain("echo");
    } finally {
      await agent.close();
    }
  });

  it("lets a session own its contributed tools' implementations via resolveTool", async () => {
    let executed = 0;
    const selfImplementingSession: Session = {
      tools: () => [{ name: "ping", config: {} }],
      resolveTool(name, _config, _agent, _capabilities) {
        if (name !== "ping") return null;
        return {
          name: "ping",
          description: "Returns pong.",
          inputSchema: { type: "object", additionalProperties: false },
          async execute() {
            executed++;
            return { content: "pong" };
          },
        };
      },
    };
    const agent = await runAgent({
      name: "self-impl-session",
      systemPrompt: "x",
      tools: {},
      capabilities: { ping: "*" },
      harness: { provider: "test" },
      session: selfImplementingSession,
    });
    try {
      const tools = agent.agentState.toolTable.list().map((t) => t.name);
      expect(tools).toContain("ping");
      const result = await agent.agentState.toolTable.execute({
        id: "call-1",
        name: "ping",
        input: {},
      });
      expect(result.content).toBe("pong");
      expect(executed).toBe(1);
    } finally {
      await agent.close();
    }
  });

  it("falls back to native impls for session-contributed names without resolveTool", async () => {
    const skillsStyle: Session = {
      tools: () => [{ name: "read_file", config: {} }],
    };
    const agent = await runAgent({
      name: "skills-style",
      systemPrompt: "x",
      tools: {},
      capabilities: { read_file: { paths: ["./"] } },
      harness: { provider: "test" },
      session: skillsStyle,
    });
    try {
      const tools = agent.agentState.toolTable.list().map((t) => t.name);
      expect(tools).toContain("read_file");
    } finally {
      await agent.close();
    }
  });
});
