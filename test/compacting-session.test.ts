import { describe, expect, it } from "vitest";

import {
  CompactingSession,
  adjustForToolPairs,
  heuristicCompactor,
} from "../src/builtins/session/compacting.js";
import { InMemorySession } from "../src/builtins/session/memory.js";
import { ChainedSession } from "../src/runtime/session-chain.js";
import { runAgent } from "../src/sdk/run-agent.js";
import type { Session } from "../src/types/interfaces.js";
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
function toolCall(id: string, name: string): SessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: id,
    title: name,
    status: "in_progress",
    rawInput: {},
  };
}
function toolUpdate(id: string): SessionUpdate {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: id,
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "ok" } }],
  };
}

/**
 * Build a fresh compacting-on-memory chain for tests. Returns the
 * composed `Session` alongside its component `compactor` and
 * `memory` instances so tests can inspect the layers individually.
 */
function freshCompacting(
  opts: ConstructorParameters<typeof CompactingSession>[0] = {},
) {
  const memory = new InMemorySession();
  const compactor = new CompactingSession(opts);
  const session: Session = new ChainedSession([compactor, memory]);
  return { session, compactor, memory };
}

describe("CompactingSession", () => {
  it("appends without compacting under threshold", async () => {
    const { session } = freshCompacting({ threshold: 10, keep: 4 });
    for (let i = 0; i < 5; i++) await session.push?.(userMsg(`m${i}`));
    const events = (await session.pull?.([])) ?? [];
    expect(events).toHaveLength(5);
  });

  it("compacts on threshold and keeps tail intact", async () => {
    const events: { before: number; after: number }[] = [];
    const { session, compactor } = freshCompacting({
      threshold: 10,
      keep: 4,
      onCompact: (info) => events.push(info),
    });
    for (let i = 0; i < 12; i++) {
      await session.push?.(i % 2 === 0 ? userMsg(`u${i}`) : agentMsg(`a${i}`));
    }
    // Auto-compaction is per-turn (via prepareTurn). Standalone use
    // pulls once (so the compactor sees the events below) and then
    // calls compactNow() to trigger.
    await session.pull?.([]);
    await compactor.compactNow();
    expect(events.length).toBeGreaterThanOrEqual(1);
    const out = (await session.pull?.([])) ?? [];
    // Head is the synthetic summary pair we inject (2 events).
    const head = out[0];
    const body = out[1];
    expect(head?.sessionUpdate).toBe("user_message_chunk");
    expect(body?.sessionUpdate).toBe("agent_message_chunk");
    // The post-compaction count must be smaller than the pre-count.
    const lastInfo = events[events.length - 1];
    expect(lastInfo).toBeDefined();
    if (lastInfo) expect(lastInfo.after).toBeLessThan(lastInfo.before);
    const last = out[out.length - 1];
    if (
      last &&
      last.sessionUpdate === "agent_message_chunk" &&
      last.content.type === "text"
    ) {
      expect(last.content.text).toBe("a11");
    } else {
      throw new Error("expected last event to be agent_message_chunk");
    }
  });

  it("never splits a tool_call from its update", async () => {
    // 12 events, with tool_call/update straddling the natural cutoff.
    const events: SessionUpdate[] = [
      userMsg("u0"),
      agentMsg("a0"),
      userMsg("u1"),
      agentMsg("a1"),
      userMsg("u2"),
      agentMsg("a2"),
      userMsg("u3"),
      toolCall("t1", "bash"), // index 7
      agentMsg("between"), // index 8 (kept)
      toolUpdate("t1"), // index 9 (kept)
      userMsg("u4"), // index 10
      agentMsg("a4"), // index 11
    ];
    expect(adjustForToolPairs(events, 8)).toBe(7);
    expect(adjustForToolPairs(events, 9)).toBe(7);
    expect(adjustForToolPairs(events, 10)).toBe(10);
  });

  it("holds last usage in memory and filters from the durable log", async () => {
    const { session, compactor, memory } = freshCompacting({
      threshold: 1000,
      keep: 2,
    });
    await session.push?.(userMsg("hi"));
    await session.push?.({
      sessionUpdate: "usage_update",
      used: 1234,
      size: 200000,
    });
    await session.push?.(agentMsg("there"));
    await session.push?.({
      sessionUpdate: "usage_update",
      used: 1500,
      size: 200000,
    });
    // The pulled view reflects only the durable log — usage_update
    // events were swallowed by the compactor and never reached memory.
    const events = (await session.pull?.([])) ?? [];
    expect(events).toHaveLength(2);
    expect(
      events.find((e) => e.sessionUpdate === "usage_update"),
    ).toBeUndefined();
    expect(
      (await memory.pull([])).find((e) => e.sessionUpdate === "usage_update"),
    ).toBeUndefined();
    // Most-recent usage values are exposed via getters on the compactor.
    expect(compactor.tokensInContext).toBe(1500);
    expect(compactor.contextWindow).toBe(200000);
  });

  it("compacts on tokenThreshold when usage data is present", async () => {
    const compactions: { before: number; after: number }[] = [];
    const { session, compactor } = freshCompacting({
      threshold: 1000, // event-count threshold; not reached
      tokenThreshold: 500,
      keep: 2,
      onCompact: (info) => compactions.push(info),
    });
    // Append a few events and a usage_update under the bar — no compaction.
    await session.push?.(userMsg("a"));
    await session.push?.(agentMsg("b"));
    await session.push?.(userMsg("c"));
    await session.push?.(agentMsg("d"));
    await session.push?.(userMsg("e"));
    await session.push?.({
      sessionUpdate: "usage_update",
      used: 100,
      size: 200000,
    });
    // Pull so the compactor sees the events below it (the runtime does
    // this every turn when assembling the prompt).
    await session.pull?.([]);
    // Fake a context-fresh: no compaction expected.
    await compactor.prepareTurn({
      harness: { run: async () => ({ stopReason: "end_turn" }) },
      session,
      systemPromptCore: "",
      agentName: "t",
    });
    expect(compactions).toHaveLength(0);
    // Now report a usage that crosses the bar — compaction trips.
    await session.push?.({
      sessionUpdate: "usage_update",
      used: 600,
      size: 200000,
    });
    await session.pull?.([]);
    await compactor.prepareTurn({
      harness: { run: async () => ({ stopReason: "end_turn" }) },
      session,
      systemPromptCore: "",
      agentName: "t",
    });
    expect(compactions).toHaveLength(1);
  });

  it("force compactNow works regardless of threshold", async () => {
    const { session, compactor } = freshCompacting({
      threshold: 1000,
      keep: 2,
    });
    for (let i = 0; i < 8; i++) await session.push?.(userMsg(`m${i}`));
    // Pull populates the compactor's view of `below`.
    await session.pull?.([]);
    const info = await compactor.compactNow();
    expect(info).not.toBeNull();
    const out = (await session.pull?.([])) ?? [];
    expect(out.length).toBeLessThan(8);
  });

  it("the heuristic compactor produces a single user/agent pair", async () => {
    const events: SessionUpdate[] = [
      userMsg("hello"),
      agentMsg("world"),
      toolCall("t1", "bash"),
      toolUpdate("t1"),
    ];
    const out = await Promise.resolve(heuristicCompactor(events, null));
    expect(out).toHaveLength(2);
    const head = out[0];
    const body = out[1];
    if (
      head &&
      body &&
      head.sessionUpdate === "user_message_chunk" &&
      body.sessionUpdate === "agent_message_chunk" &&
      body.content.type === "text"
    ) {
      expect(body.content.text).toContain("user:");
      expect(body.content.text).toContain("agent:");
      expect(body.content.text).toContain("tool bash");
    } else {
      throw new Error("unexpected compactor output shape");
    }
  });

  it("plugs into runAgent as a Session instance", async () => {
    const { session } = freshCompacting({ threshold: 6, keep: 2 });
    const agent = await runAgent({
      name: "compact-test",
      tools: {},
      harness: {
        provider: "test",
        script: [
          [{ say: "ack" }, { stop: "end_turn" }],
          [{ say: "ack" }, { stop: "end_turn" }],
          [{ say: "ack" }, { stop: "end_turn" }],
          [{ say: "ack" }, { stop: "end_turn" }],
        ],
      },
      session,
    });
    try {
      await agent.prompt("p1");
      await agent.prompt("p2");
      await agent.prompt("p3");
      await agent.prompt("p4");
      // Should have triggered at least one compaction by now.
      const events = (await agent.session.pull?.([])) ?? [];
      // Synthetic summary is the first event.
      const first = events[0];
      if (
        first &&
        first.sessionUpdate === "user_message_chunk" &&
        first.content.type === "text"
      ) {
        expect(first.content.text).toMatch(/summary/i);
      } else {
        throw new Error("expected first event to be the summary");
      }
    } finally {
      await agent.close();
    }
  });
});
