import { describe, expect, it } from "vitest";

import {
  CompactingSession,
  modelCompactor,
} from "../src/builtins/session/compacting.js";
import { InMemorySession } from "../src/builtins/session/memory.js";
import { ChainedSession } from "../src/runtime/session-chain.js";
import { runAgent } from "../src/sdk/run-agent.js";
import { summarise, summariseViaRun } from "../src/sdk/session-utils.js";
import type {
  Agent,
  Harness,
  Runtime,
  Session,
} from "../src/types/interfaces.js";
import type { SessionUpdate } from "../src/types/acp.js";

function freshCompactingChain(
  opts: ConstructorParameters<typeof CompactingSession>[0] = {},
) {
  const memory = new InMemorySession();
  const compactor = new CompactingSession(opts);
  const session: Session = new ChainedSession([compactor, memory]);
  return { session, compactor, memory };
}

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

function fakeAgent(harness: Harness, session: Session): Agent {
  return {
    manifest: { name: "t", harness: { provider: "test" } },
    harness,
    session,
    systemPromptCore: "test-core",
  };
}

function summaryText(out: SessionUpdate[]): string {
  const body = out[1];
  if (
    body &&
    body.sessionUpdate === "agent_message_chunk" &&
    body.content.type === "text"
  ) {
    return body.content.text;
  }
  throw new Error("expected agent_message_chunk with summary");
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
        // Neutral summary, not in the parent agent's persona.
        expect(args.systemPrompt).toBe("");
        return "everything is fine, carry on";
      },
    };
    const { session, compactor } = freshCompactingChain({
      threshold: 6,
      keep: 2,
      compactor: modelCompactor(),
    });
    for (let i = 0; i < 8; i++) await session.push?.(userMsg(`m${i}`));
    await session.pull?.([]);
    await compactor.prepareTurn(fakeAgent(harness, session));
    expect(called).toBe(true);
    expect(summaryText((await session.pull?.([])) ?? [])).toContain(
      "everything is fine",
    );
  });

  it("falls back to summariseViaRun when harness has no native summarise", async () => {
    const harness = fixedTextHarness("VIA_RUN_SUMMARY");
    const { session, compactor } = freshCompactingChain({
      threshold: 6,
      keep: 2,
      compactor: modelCompactor(),
    });
    for (let i = 0; i < 8; i++) await session.push?.(userMsg(`m${i}`));
    await session.pull?.([]);
    await compactor.prepareTurn(fakeAgent(harness, session));
    expect(summaryText((await session.pull?.([])) ?? [])).toContain(
      "VIA_RUN_SUMMARY",
    );
  });

  it("falls back to the heuristic compactor when ctx is null", async () => {
    const { session, compactor } = freshCompactingChain({
      threshold: 6,
      keep: 2,
      compactor: modelCompactor(),
    });
    for (let i = 0; i < 8; i++) await session.push?.(userMsg(`hello ${i}`));
    await session.pull?.([]);
    await compactor.compactNow();
    expect(summaryText((await session.pull?.([])) ?? [])).toContain("user:");
  });

  it("runAgent passes a fresh Agent ref to prepareTurn each turn", async () => {
    const seenHarnesses: Harness[] = [];
    const harness = fixedTextHarness("ack");

    const { session, compactor } = freshCompactingChain({
      threshold: 1000,
      keep: 2,
    });
    const realPrepare = compactor.prepareTurn.bind(compactor);
    compactor.prepareTurn = async (agent: Agent) => {
      seenHarnesses.push(agent.harness);
      expect(agent.session).toBe(session);
      expect(agent.manifest.name).toBe("turn-test");
      expect(agent.manifest.description).toBe("for the test");
      expect(agent.systemPromptCore).toBeTypeOf("string");
      await realPrepare(agent);
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
