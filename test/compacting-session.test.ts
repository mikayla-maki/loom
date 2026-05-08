import { describe, expect, it } from "vitest";

import {
  CompactingSession,
  adjustForToolPairs,
  heuristicCompactor,
} from "../src/extensions/session/compacting.js";
import { runAgent } from "../src/sdk/run-agent.js";
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
    input: {},
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

describe("CompactingSession", () => {
  it("appends without compacting under threshold", async () => {
    const s = new CompactingSession({ threshold: 10, keep: 4 });
    for (let i = 0; i < 5; i++) await s.append(userMsg(`m${i}`));
    expect(await s.count()).toBe(5);
  });

  it("compacts on threshold and keeps tail intact", async () => {
    const events: { before: number; after: number }[] = [];
    const s = new CompactingSession({
      threshold: 10,
      keep: 4,
      onCompact: (info) => events.push(info),
    });
    for (let i = 0; i < 12; i++) {
      await s.append(i % 2 === 0 ? userMsg(`u${i}`) : agentMsg(`a${i}`));
    }
    // Auto-compaction is per-turn (via prepareTurn). Standalone use
    // calls compactNow() to trigger.
    await s.compactNow();
    expect(events.length).toBeGreaterThanOrEqual(1);
    const out = await s.getEvents();
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
    // threshold 10, keep 4 → desired cutoff = 8
    // Lay out so the call is at index 7, the update at index 9.
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
    const s = new CompactingSession({ threshold: 1000, keep: 2 });
    await s.append(userMsg("hi"));
    await s.append({
      sessionUpdate: "usage_update",
      used: 1234,
      size: 200000,
    });
    await s.append(agentMsg("there"));
    await s.append({
      sessionUpdate: "usage_update",
      used: 1500,
      size: 200000,
    });
    // count() reflects only the durable log — usage_update doesn't count.
    expect(await s.count()).toBe(2);
    const events = await s.getEvents();
    expect(
      events.find((e) => e.sessionUpdate === "usage_update"),
    ).toBeUndefined();
    // Most-recent usage values are exposed via getters.
    expect(s.tokensInContext).toBe(1500);
    expect(s.contextWindow).toBe(200000);
  });

  it("compacts on tokenThreshold when usage data is present", async () => {
    const compactions: { before: number; after: number }[] = [];
    const s = new CompactingSession({
      threshold: 1000, // event-count threshold; not reached
      tokenThreshold: 500,
      keep: 2,
      onCompact: (info) => compactions.push(info),
    });
    // Append a few events and a usage_update under the bar — no compaction.
    await s.append(userMsg("a"));
    await s.append(agentMsg("b"));
    await s.append(userMsg("c"));
    await s.append(agentMsg("d"));
    await s.append(userMsg("e"));
    await s.append({
      sessionUpdate: "usage_update",
      used: 100,
      size: 200000,
    });
    // Fake a context-fresh: no compaction expected.
    await s.prepareTurn({
      harness: { run: async () => ({ stopReason: "end_turn" }) },
      session: s,
      systemPromptCore: "",
      agentName: "t",
    });
    expect(compactions).toHaveLength(0);
    // Now report a usage that crosses the bar — compaction trips.
    await s.append({
      sessionUpdate: "usage_update",
      used: 600,
      size: 200000,
    });
    await s.prepareTurn({
      harness: { run: async () => ({ stopReason: "end_turn" }) },
      session: s,
      systemPromptCore: "",
      agentName: "t",
    });
    expect(compactions).toHaveLength(1);
  });

  it("force compactNow works regardless of threshold", async () => {
    const s = new CompactingSession({ threshold: 1000, keep: 2 });
    for (let i = 0; i < 8; i++) await s.append(userMsg(`m${i}`));
    const info = await s.compactNow();
    expect(info).not.toBeNull();
    const out = await s.getEvents();
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
    const s = new CompactingSession({ threshold: 6, keep: 2 });
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
      session: s,
    });
    try {
      await agent.prompt("p1");
      await agent.prompt("p2");
      await agent.prompt("p3");
      await agent.prompt("p4");
      // Should have triggered at least one compaction by now.
      const events = await agent.session.getEvents();
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
