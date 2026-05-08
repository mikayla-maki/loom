import { describe, expect, it } from "vitest";

import {
  CompactingSession,
  modelCompactor,
} from "../src/extensions/session/compacting.js";
import { runAgent } from "../src/sdk/run-agent.js";
import { summarise, summariseViaRun } from "../src/sdk/session-utils.js";
import type {
  Harness,
  Runtime,
  SessionContext,
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

/** Tiny harness that emits a fixed reply and ends the turn. */
function fixedTextHarness(reply: string): Harness {
  return {
    async run(rt: Runtime) {
      await rt.update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: reply },
      });
      await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
      return { stopReason: "end_turn" as const };
    },
  };
}

function fakeCtx(harness: Harness): SessionContext {
  return {
    harness,
    systemPromptCore: "test-core",
    agentName: "t",
  };
}

describe("modelCompactor + Session.prepareTurn", () => {
  it("uses the harness's native summarise() when present", async () => {
    let called = false;
    const harness: Harness = {
      async run() {
        throw new Error("run() should not be called when summarise() exists");
      },
      async summarise(args) {
        called = true;
        expect(args.events.length).toBeGreaterThan(0);
        expect(args.instruction).toMatch(/summari[sz]ing/i);
        expect(args.systemPrompt).toBe("test-core");
        return "everything is fine, carry on";
      },
    };
    const session = new CompactingSession({
      threshold: 6,
      keep: 2,
      compactor: modelCompactor(),
    });
    for (let i = 0; i < 8; i++) await session.append(userMsg(`m${i}`));
    await session.prepareTurn(fakeCtx(harness));
    expect(called).toBe(true);
    const out = await session.getEvents();
    const body = out[1];
    if (
      body &&
      body.sessionUpdate === "agent_message_chunk" &&
      body.content.type === "text"
    ) {
      expect(body.content.text).toContain("everything is fine");
    } else {
      throw new Error("expected agent_message_chunk with model summary");
    }
  });

  it("falls back to summariseViaRun when harness has no native summarise", async () => {
    const harness = fixedTextHarness("VIA_RUN_SUMMARY");
    const session = new CompactingSession({
      threshold: 6,
      keep: 2,
      compactor: modelCompactor(),
    });
    for (let i = 0; i < 8; i++) await session.append(userMsg(`m${i}`));
    await session.prepareTurn(fakeCtx(harness));
    const out = await session.getEvents();
    const body = out[1];
    if (
      body &&
      body.sessionUpdate === "agent_message_chunk" &&
      body.content.type === "text"
    ) {
      expect(body.content.text).toContain("VIA_RUN_SUMMARY");
    } else {
      throw new Error("expected fallback synthetic-run summary");
    }
  });

  it("falls back to the heuristic compactor when ctx is null", async () => {
    const session = new CompactingSession({
      threshold: 6,
      keep: 2,
      compactor: modelCompactor(),
    });
    for (let i = 0; i < 8; i++) {
      await session.append(userMsg(`hello ${i}`));
    }
    // Force compaction with no context — modelCompactor should fall
    // back to heuristic.
    await session.compactNow();
    const out = await session.getEvents();
    const body = out[1];
    if (
      body &&
      body.sessionUpdate === "agent_message_chunk" &&
      body.content.type === "text"
    ) {
      // Heuristic-style summary contains "user:" prefixes.
      expect(body.content.text).toContain("user:");
    } else {
      throw new Error("expected fallback heuristic output");
    }
  });

  it("runAgent passes a fresh SessionContext to prepareTurn each turn", async () => {
    const seenHarnesses: Harness[] = [];
    const harness = fixedTextHarness("ack");

    const session = new CompactingSession({ threshold: 1000, keep: 2 });
    // Wrap prepareTurn so we can observe what loom passed in.
    const realPrepare = session.prepareTurn.bind(session);
    session.prepareTurn = async (ctx) => {
      seenHarnesses.push(ctx.harness);
      expect(ctx.agentName).toBe("turn-test");
      expect(ctx.agentDescription).toBe("for the test");
      expect(ctx.systemPromptCore).toBeTypeOf("string");
      await realPrepare(ctx);
    };

    const agent = await runAgent({
      name: "turn-test",
      description: "for the test",
      tools: {},
      harness,
      session,
    });
    try {
      await agent.prompt("p1");
      await agent.prompt("p2");
      expect(seenHarnesses).toHaveLength(2);
      expect(seenHarnesses[0]).toBe(harness);
      expect(seenHarnesses[1]).toBe(harness);
    } finally {
      await agent.close();
    }
  });

  it("summarise() helper picks native impl when available", async () => {
    const native: Harness = {
      async run() {
        throw new Error("run() should not be called");
      },
      async summarise() {
        return "native";
      },
    };
    const out = await summarise(native, {
      events: [userMsg("hi"), agentMsg("there")],
      instruction: "summarize",
      systemPrompt: "core",
    });
    expect(out).toBe("native");
  });

  it("summariseViaRun() drives a tool-free run() loop", async () => {
    const harness = fixedTextHarness("RUN_RESULT");
    const out = await summariseViaRun(harness, {
      events: [userMsg("hi"), agentMsg("there")],
      instruction: "summarize",
      systemPrompt: "core",
    });
    expect(out).toBe("RUN_RESULT");
  });
});
