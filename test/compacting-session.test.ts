import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

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
import { withTmpDir } from "./helpers/tmp.js";

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

function freshCompacting(
  opts: ConstructorParameters<typeof CompactingSession>[0] = {},
) {
  const memory = new InMemorySession();
  const compactor = new CompactingSession(opts);
  const session: Session = new ChainedSession([compactor, memory]);
  return { session, compactor, memory };
}

function stubAgent(session: Session) {
  return {
    manifest: { name: "t", harness: { provider: "test" } },
    harness: { run: async () => ({ stopReason: "end_turn" as const }) },
    session,
    systemPromptCore: "",
  };
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
    await session.pull?.([]);
    await compactor.compactNow();
    expect(events.length).toBeGreaterThanOrEqual(1);

    const out = (await session.pull?.([])) ?? [];
    expect(out[0]?.sessionUpdate).toBe("user_message_chunk");
    expect(out[1]?.sessionUpdate).toBe("agent_message_chunk");

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
    const events: SessionUpdate[] = [
      userMsg("u0"),
      agentMsg("a0"),
      userMsg("u1"),
      agentMsg("a1"),
      userMsg("u2"),
      agentMsg("a2"),
      userMsg("u3"),
      toolCall("t1", "bash"),
      agentMsg("between"),
      toolUpdate("t1"),
      userMsg("u4"),
      agentMsg("a4"),
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

    const events = (await session.pull?.([])) ?? [];
    expect(events).toHaveLength(2);
    expect(
      events.find((e) => e.sessionUpdate === "usage_update"),
    ).toBeUndefined();
    expect(
      (await memory.pull([])).find((e) => e.sessionUpdate === "usage_update"),
    ).toBeUndefined();
    expect(compactor.tokensInContext).toBe(1500);
    expect(compactor.contextWindow).toBe(200000);
  });

  it("compacts on tokenThreshold when usage data is present", async () => {
    const compactions: { before: number; after: number }[] = [];
    const { session, compactor } = freshCompacting({
      threshold: 1000,
      tokenThreshold: 500,
      keep: 2,
      onCompact: (info) => compactions.push(info),
    });
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
    await session.pull?.([]);
    await compactor.prepareTurn(stubAgent(session));
    expect(compactions).toHaveLength(0);

    await session.push?.({
      sessionUpdate: "usage_update",
      used: 600,
      size: 200000,
    });
    await session.pull?.([]);
    await compactor.prepareTurn(stubAgent(session));
    expect(compactions).toHaveLength(1);
  });

  it("force compactNow works regardless of threshold", async () => {
    const { session, compactor } = freshCompacting({
      threshold: 1000,
      keep: 2,
    });
    for (let i = 0; i < 8; i++) await session.push?.(userMsg(`m${i}`));
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
      const events = (await agent.session.pull?.([])) ?? [];
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

describe("CompactingSession — tokenFraction", () => {
  it("compacts when used/size crosses the fraction", async () => {
    const compactions: { before: number; after: number }[] = [];
    const { session, compactor } = freshCompacting({
      threshold: 10_000,
      tokenFraction: 0.5,
      keep: 2,
      onCompact: (info) => compactions.push(info),
    });

    for (let i = 0; i < 6; i++) await session.push?.(userMsg(`m${i}`));
    await session.push?.({
      sessionUpdate: "usage_update",
      used: 70_000,
      size: 200_000,
    });
    await session.pull?.([]);
    await compactor.prepareTurn(stubAgent(session));
    expect(compactions).toHaveLength(0);

    // 110k/200k = 55% > 0.5, so compaction trips.
    await session.push?.({
      sessionUpdate: "usage_update",
      used: 110_000,
      size: 200_000,
    });
    await session.pull?.([]);
    await compactor.prepareTurn(stubAgent(session));
    expect(compactions).toHaveLength(1);
  });

  it("tokenFraction takes priority over tokenThreshold when both set", async () => {
    const compactions: { before: number; after: number }[] = [];
    const { session, compactor } = freshCompacting({
      threshold: 10_000,
      tokenThreshold: 1_000_000,
      tokenFraction: 0.25,
      keep: 2,
      onCompact: (info) => compactions.push(info),
    });

    for (let i = 0; i < 4; i++) await session.push?.(userMsg(`m${i}`));
    await session.push?.({
      sessionUpdate: "usage_update",
      used: 60_000,
      size: 200_000,
    });
    await session.pull?.([]);
    await compactor.prepareTurn(stubAgent(session));
    expect(compactions).toHaveLength(1);
  });
});

describe("CompactingSession — persistence", () => {
  it("writes state.json after a compaction", async () => {
    await withTmpDir("loom-compact-test-", async (persistDir) => {
      const memory = new InMemorySession();
      const compactor = new CompactingSession({ threshold: 10, keep: 4, persistDir });
      const session: Session = new ChainedSession([compactor, memory]);

      for (let i = 0; i < 12; i++) {
        await session.push?.(i % 2 === 0 ? userMsg(`u${i}`) : agentMsg(`a${i}`));
      }
      await session.pull?.([]);
      await compactor.compactNow();

      const raw = await fs.readFile(path.join(persistDir, "state.json"), "utf8");
      const parsed = JSON.parse(raw) as {
        version: number;
        summarizedThrough: number;
        cachedSummary: SessionUpdate[];
      };
      expect(parsed.version).toBe(1);
      expect(parsed.summarizedThrough).toBe(8); // 12 - keep(4)
      expect(parsed.cachedSummary).toHaveLength(2);
    });
  });

  it("loads state.json on first pull of a fresh instance", async () => {
    await withTmpDir("loom-compact-test-", async (persistDir) => {
      const seeded = {
        version: 1,
        summarizedThrough: 3,
        cachedSummary: [
          userMsg("[summary] earlier discussion about Liouville volume"),
          agentMsg("[summary recap] noted; carry forward"),
        ],
      };
      await fs.writeFile(
        path.join(persistDir, "state.json"),
        JSON.stringify(seeded),
        "utf8",
      );

      const memory = new InMemorySession();
      await memory.push?.(userMsg("e0"));
      await memory.push?.(agentMsg("e1"));
      await memory.push?.(userMsg("e2"));
      await memory.push?.(agentMsg("e3"));
      await memory.push?.(userMsg("e4"));
      const compactor = new CompactingSession({ persistDir });
      const session: Session = new ChainedSession([compactor, memory]);

      const out = (await session.pull?.([])) ?? [];
      expect(out).toHaveLength(4); // 2 summary + memory.slice(3)
      const first = out[0];
      if (
        first &&
        first.sessionUpdate === "user_message_chunk" &&
        first.content.type === "text"
      ) {
        expect(first.content.text).toContain("Liouville");
      } else {
        throw new Error("expected loaded summary as first event");
      }
    });
  });

  it("ignores corrupt state.json and rebuilds from scratch", async () => {
    await withTmpDir("loom-compact-test-", async (persistDir) => {
      await fs.writeFile(path.join(persistDir, "state.json"), "{not json", "utf8");

      const memory = new InMemorySession();
      await memory.push?.(userMsg("hello"));
      const compactor = new CompactingSession({ persistDir });
      const session: Session = new ChainedSession([compactor, memory]);

      const out = (await session.pull?.([])) ?? [];
      expect(out).toHaveLength(1);
    });
  });

  it("persists lastUsed/lastSize so tokenFraction trips across instances", async () => {
    // Per-turn-subprocess deployments build a fresh CompactingSession each
    // turn; usage data must survive to disk or tokenFraction never trips.
    await withTmpDir("loom-compact-test-", async (persistDir) => {
      {
        const memory = new InMemorySession();
        const compactor = new CompactingSession({
          persistDir,
          threshold: 10_000,
          tokenFraction: 0.75,
          keep: 2,
        });
        const session: Session = new ChainedSession([compactor, memory]);
        for (let i = 0; i < 4; i++) await session.push?.(userMsg(`m${i}`));
        await session.push?.({
          sessionUpdate: "usage_update",
          used: 180_000,
          size: 200_000,
        });
      }

      {
        const compactions: { before: number; after: number }[] = [];
        const memory = new InMemorySession();
        for (let i = 0; i < 4; i++) await memory.push?.(userMsg(`m${i}`));
        const compactor = new CompactingSession({
          persistDir,
          threshold: 10_000,
          tokenFraction: 0.75,
          keep: 2,
          onCompact: (info) => compactions.push(info),
        });
        const session: Session = new ChainedSession([compactor, memory]);
        await session.pull?.([]);
        expect(compactor.tokensInContext).toBe(180_000);
        expect(compactor.contextWindow).toBe(200_000);
        await compactor.prepareTurn(stubAgent(session));
        expect(compactions).toHaveLength(1);
      }
    });
  });
});

describe("CompactingSession — recompaction discipline", () => {
  it("re-compacts only once growth past the last summary crosses threshold", async () => {
    const compactions: { before: number; after: number }[] = [];
    const { session, compactor } = freshCompacting({
      threshold: 10,
      keep: 4,
      onCompact: (info) => compactions.push(info),
    });

    // First compaction: 12 events, threshold 10, summarizedThrough -> 8.
    for (let i = 0; i < 12; i++) await session.push?.(userMsg(`m${i}`));
    await session.pull?.([]);
    await compactor.prepareTurn(stubAgent(session));
    expect(compactions).toHaveLength(1);

    // 16 events: growth past summary = 8, still under threshold 10.
    for (let i = 12; i < 16; i++) await session.push?.(userMsg(`m${i}`));
    await session.pull?.([]);
    await compactor.prepareTurn(stubAgent(session));
    expect(compactions).toHaveLength(1);

    // 24 events: growth past summary = 16, over threshold 10.
    for (let i = 16; i < 24; i++) await session.push?.(userMsg(`m${i}`));
    await session.pull?.([]);
    await compactor.prepareTurn(stubAgent(session));
    expect(compactions).toHaveLength(2);
  });
});
