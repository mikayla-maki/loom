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
  it("push and pull are optional; undefined defaults to passthrough at the chain level", async () => {
    // A session implementing only systemPromptSection — like a skills
    // catalog. push and pull are absent. ChainedSession should treat
    // it as passthrough on both directions.
    const promptOnly: Session = {
      systemPromptSection: () => "# Custom Section",
    };
    const log = new InMemorySession();
    const chained = new ChainedSession([log, promptOnly]);

    await chained.push(userMsg("hello"));
    await chained.push(agentMsg("hi back"));

    const events = await chained.pull([]);
    // The promptOnly session is a passthrough; the events come from the log.
    expect(events).toHaveLength(2);
    expect(events[0]?.sessionUpdate).toBe("user_message_chunk");
    expect(events[1]?.sessionUpdate).toBe("agent_message_chunk");
  });

  it("push fan-out: a session can split one event into many", async () => {
    const fanout: Session = {
      async push(event) {
        // Fan one event into two copies, with a marker in the second.
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

  it("push drop: returning [] swallows an event before it reaches downstream", async () => {
    // A redaction-style session: drops user_message_chunk events.
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
    // user_message dropped before reaching the log; only the agent
    // message survived.
    expect(events).toHaveLength(1);
    expect(events[0]?.sessionUpdate).toBe("agent_message_chunk");
  });

  it("pull chain: bottom-to-top transformation", async () => {
    // Three sessions: a leaf log, a session that doubles every text
    // event on pull, and a session that adds a synthetic prefix event.
    const log = new InMemorySession();
    const doubler: Session = {
      async pull(below) {
        // Duplicate every event — pulled events are doubled.
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
    // pull runs reversed: prefixer last (top), then doubler, then log.
    // Wait — chain order in pull is reversed from push. Let me trace:
    //   pull():
    //     start with []
    //     prefixer.pull([]) → [prefix]
    //     doubler.pull([prefix]) → [prefix, prefix]
    //     log.pull([prefix, prefix]) → [a]  (log ignores upstream)
    //   = [a]
    // Hmm, log replaces because it's a leaf that produces from internal state.
    // Verify: leaf InMemorySession ignores `below`.
    expect(events).toHaveLength(1);
    expect(events[0]?.sessionUpdate).toBe("user_message_chunk");
  });

  it("pull chain with passthrough leaves: each transformer sees and augments", async () => {
    // Leaf-style session that PASSES THROUGH instead of replacing.
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
    // Outer caller passes events into pull (simulating a synthetic
    // "below" rather than a leaf-produced state).
    const events = await chained.pull([userMsg("a"), userMsg("b")]);
    // pull runs: prefixer first (top of reversed iteration), then doubler, then leaf.
    //   prefixer([a,b]) → [prefix, a, b]
    //   doubler([prefix, a, b]) → [prefix, prefix, a, a, b, b]
    //   leaf([prefix,prefix,a,a,b,b]) → [prefix,prefix,a,a,b,b]
    expect(events).toHaveLength(6);
  });

  it("hooks compose: prepareTurn / systemPromptSection / tools / dependencies", async () => {
    const calls: string[] = [];

    const a: Session = {
      async prepareTurn() {
        calls.push("a:prepare");
      },
      systemPromptSection: () => "section A",
      tools: () => [{ name: "tool_a", config: {} }],
      dependencies: {
        subagents: [
          {
            name: "sub-a",
            harness: { provider: "test" },
          },
        ],
      },
    };
    const b: Session = {
      async prepareTurn() {
        calls.push("b:prepare");
      },
      systemPromptSection: () => "section B",
      tools: () => [{ name: "tool_b", config: {} }],
      dependencies: {
        subagents: [
          {
            name: "sub-b",
            harness: { provider: "test" },
          },
        ],
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

  it("close runs in declaration order", async () => {
    const closed: string[] = [];
    const a: Session = { close: async () => void closed.push("a") };
    const b: Session = { close: async () => void closed.push("b") };
    const chained = new ChainedSession([a, b]);
    await chained.close?.();
    expect(closed).toEqual(["a", "b"]);
  });
});

describe("CompactingSession (chain transform)", () => {
  it("passes pushed events through to the storage layer below", async () => {
    const memory = new InMemorySession();
    const compactor = new CompactingSession({ threshold: 100, keep: 10 });
    const session = new ChainedSession([compactor, memory]);

    await session.push(userMsg("a"));
    await session.push(agentMsg("b"));

    // Storage layer sees the raw events.
    const stored = await memory.pull([]);
    expect(stored).toHaveLength(2);
  });

  it("compactNow caches summary and shrinks the pull view", async () => {
    const memory = new InMemorySession();
    const compactor = new CompactingSession({ threshold: 100, keep: 2 });
    const session = new ChainedSession([compactor, memory]);
    for (let i = 0; i < 8; i++) {
      await session.push(i % 2 === 0 ? userMsg(`u${i}`) : agentMsg(`a${i}`));
    }

    // Before compaction, pull returns all 8.
    expect(await session.pull([])).toHaveLength(8);

    await compactor.compactNow();

    // After compaction: 2 summary events + 2 kept = 4.
    const after = await session.pull([]);
    expect(after).toHaveLength(4);
    // Storage layer is unchanged — we only cache the summary in the
    // compactor.
    expect(await memory.pull([])).toHaveLength(8);
  });

  it("usage_update events don't pollute the storage layer", async () => {
    const memory = new InMemorySession();
    const compactor = new CompactingSession({ threshold: 100, keep: 2 });
    const session = new ChainedSession([compactor, memory]);

    await session.push(userMsg("hi"));
    await session.push({
      sessionUpdate: "usage_update",
      used: 1234,
      size: 200000,
    });
    await session.push(agentMsg("bye"));

    const stored = await memory.pull([]);
    // Storage only sees the two real messages.
    expect(stored).toHaveLength(2);
    expect(compactor.tokensInContext).toBe(1234);
    expect(compactor.contextWindow).toBe(200000);
  });
});

describe("Convenience builders", () => {
  it("compactingMemorySession returns a composed chain", async () => {
    const s = compactingMemorySession({ threshold: 5, keep: 2 });
    // Helper returns the chain wrapper, not a raw CompactingSession.
    expect(s).toBeInstanceOf(ChainedSession);
    expect(s).not.toBeInstanceOf(CompactingSession);
    await s.push?.(userMsg("test"));
    const events = (await s.pull?.([])) ?? [];
    expect(events).toHaveLength(1);
  });
});

describe("End-to-end: ChainedSession through runAgent", () => {
  it("the agent boots with a chained session and can read context", async () => {
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

  it("manifest-form SessionSpec[] chain (compacting + memory) actually compacts", async () => {
    // End-to-end: declare a chain via SessionSpec[] on the manifest;
    // runAgent assembles a ChainedSession internally; compaction
    // fires once enough events accrue.
    const turns: TurnStep[][] = [];
    for (let i = 0; i < 6; i++)
      turns.push([{ say: "ack" }, { stop: "end_turn" }]);
    const agent = await runAgent({
      name: "chain-runs",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test", script: turns },
      // Aggressive thresholds so the test can drive compaction in a
      // small number of turns.
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
        // Heuristic compactor's summary always opens with this banner.
        expect(first.content.text).toMatch(/summary/i);
      } else {
        throw new Error("expected first event to be the synthetic summary");
      }
    } finally {
      await agent.close();
    }
  });

  it("manifest-form chain order is honoured (outer-to-inner)", async () => {
    // Two pass-through layers that mark events on the way through;
    // chain order should be reflected in the prompt order.
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
    // push: outer→inner → A then B (memory has no push hook → defaults to passthrough).
    // pull: inner→outer → B then A (memory has its own pull that ignores below).
    expect(order.filter((s) => s.startsWith("A"))).toEqual([
      "A:push",
      "A:pull",
    ]);
    expect(order.filter((s) => s.startsWith("B"))).toEqual([
      "B:push",
      "B:pull",
    ]);
    // Outer-to-inner ordering on push.
    expect(order.indexOf("A:push")).toBeLessThan(order.indexOf("B:push"));
    // Inner-to-outer ordering on pull.
    expect(order.indexOf("B:pull")).toBeLessThan(order.indexOf("A:pull"));
  });

  it("a session contributing tools via tools() registers them at boot", async () => {
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

  it("a session that implements resolveTool owns its contributed tools' implementations", async () => {
    // The full self-implementing pattern: session both advertises a
    // tool name (via tools()) AND owns its impl (via resolveTool). No
    // separate Tools registration; no [tools.X] entry in the manifest.
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
      // Execute the tool through the table to confirm the resolveTool
      // path actually wires up the implementation.
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

  it("session-contributed names without resolveTool fall back to native (skills pattern)", async () => {
    // SkillsSession-style: contribute a tool name whose implementation
    // lives in the native provider. The session itself has no
    // resolveTool; the runtime's `(session) → native` fallback chain
    // makes this work.
    const skillsStyle: Session = {
      tools: () => [{ name: "read_file", config: {} }],
      // No resolveTool. read_file lives in native.
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
