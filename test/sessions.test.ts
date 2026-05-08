import { describe, expect, it } from "vitest";

import {
  ChainedSession,
  CompactingSession,
  compactingMemorySession,
} from "../src/extensions/session/compacting.js";
import { MemorySession } from "../src/extensions/session/memory.js";
import { runAgent } from "../src/sdk/run-agent.js";
import type {
  Agent,
  Runtime,
  Session,
  ToolRef,
} from "../src/types/interfaces.js";
import type { SessionUpdate } from "../src/types/acp.js";

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
    const log = new MemorySession();
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
    const log = new MemorySession();
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
    const log = new MemorySession();
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
    const log = new MemorySession();
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
    // Verify: leaf MemorySession ignores `below`.
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
      harness: { run: async () => ({ stopReason: "end_turn" as const }) },
      session: chained,
      systemPromptCore: "x",
      agentName: "x",
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

describe("CompactingSession (wrapping pattern)", () => {
  it("forwards push to the inner session", async () => {
    const inner = new MemorySession();
    const c = new CompactingSession(inner, { threshold: 100, keep: 10 });
    await c.push(userMsg("a"));
    await c.push(agentMsg("b"));

    // Inner sees the events.
    const innerEvents = await inner.pull([]);
    expect(innerEvents).toHaveLength(2);
  });

  it("compactNow caches summary and shrinks the pull view", async () => {
    const inner = new MemorySession();
    const c = new CompactingSession(inner, { threshold: 100, keep: 2 });
    for (let i = 0; i < 8; i++) {
      await c.push(i % 2 === 0 ? userMsg(`u${i}`) : agentMsg(`a${i}`));
    }

    // Before compaction, pull returns all 8.
    expect(await c.pull([])).toHaveLength(8);

    await c.compactNow();

    // After compaction: 2 summary events + 2 kept = 4.
    const after = await c.pull([]);
    expect(after).toHaveLength(4);
    // Inner is unchanged — we only cache the summary.
    expect(await inner.pull([])).toHaveLength(8);
  });

  it("usage_update events don't pollute the inner session", async () => {
    const inner = new MemorySession();
    const c = new CompactingSession(inner, { threshold: 100, keep: 2 });
    await c.push(userMsg("hi"));
    await c.push({
      sessionUpdate: "usage_update",
      used: 1234,
      size: 200000,
    });
    await c.push(agentMsg("bye"));

    const events = await inner.pull([]);
    // Inner only sees the two real messages.
    expect(events).toHaveLength(2);
    expect(c.tokensInContext).toBe(1234);
    expect(c.contextWindow).toBe(200000);
  });
});

describe("Convenience builders", () => {
  it("compactingMemorySession returns a CompactingSession wrapping MemorySession", async () => {
    const s = compactingMemorySession({ threshold: 5, keep: 2 });
    expect(s).toBeInstanceOf(CompactingSession);
    await s.push(userMsg("test"));
    const events = await s.pull([]);
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
      session: new ChainedSession([new MemorySession()]),
    });
    try {
      await agent.prompt("hello world");
      expect(captured).toBe("hello world");
    } finally {
      await agent.close();
    }
  });

  it("a session contributing tools via tools() registers them at boot", async () => {
    const sessionWithTool: Session = {
      tools: () => [{ name: "echo", config: {} }],
    };
    const agent = await runAgent({
      name: "session-tools",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test" },
      session: sessionWithTool,
    });
    try {
      const tools = agent.agentState.toolTable.list().map((t) => t.name);
      expect(tools).toContain("echo");
    } finally {
      await agent.close();
    }
  });
});
