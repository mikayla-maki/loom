import { describe, expect, it } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import type {
  Agent,
  Harness,
  Runtime,
  Session,
} from "../src/types/interfaces.js";
import type { SessionUpdate, StopReason } from "../src/types/acp.js";

/**
 * The Session can contribute a section to the assembled system prompt.
 * Loom calls `systemPromptSection(agent)` per turn, after
 * `prepareTurn`, passing a fresh `Agent` ref — nothing is bound at
 * boot.
 */

describe("Session.systemPromptSection", () => {
  it("contributes a section that lands in the assembled system prompt", async () => {
    let capturedSystemPrompt: string | null = null;
    const harness: Harness = {
      async run(rt: Runtime) {
        capturedSystemPrompt = rt.systemPrompt();
        await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return { stopReason: "end_turn" as const };
      },
    };

    const seenAgents: Agent[] = [];
    const session: Session = {
      events: [] as SessionUpdate[],
      async append(u: SessionUpdate) {
        (this as unknown as { events: SessionUpdate[] }).events.push(u);
      },
      async getEvents(from?: number, to?: number) {
        return (this as unknown as { events: SessionUpdate[] }).events.slice(
          from,
          to,
        );
      },
      async count() {
        return (this as unknown as { events: SessionUpdate[] }).events.length;
      },
      systemPromptSection(agent: Agent) {
        seenAgents.push(agent);
        return "Recently retrieved memories: user prefers terse replies.";
      },
    } as unknown as Session;

    const agent = await runAgent({
      name: "section-test",
      tools: {},
      harness,
      session,
    });
    try {
      await agent.prompt("anything");
      expect(seenAgents).toHaveLength(1);
      expect(seenAgents[0]?.harness).toBe(harness);
      expect(seenAgents[0]?.session).toBe(session);
      expect(seenAgents[0]?.agentName).toBe("section-test");
      expect(capturedSystemPrompt).not.toBeNull();
      expect(capturedSystemPrompt!).toContain("# Session");
      expect(capturedSystemPrompt!).toContain("user prefers terse replies");
    } finally {
      await agent.close();
    }
  });

  it("is called per turn with a fresh Agent ref", async () => {
    let calls = 0;
    const harness: Harness = {
      async run(rt: Runtime) {
        // Read once so the section is realised.
        rt.systemPrompt();
        await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return { stopReason: "end_turn" as const };
      },
    };

    const session: Session = {
      events: [] as SessionUpdate[],
      async append(u: SessionUpdate) {
        (this as unknown as { events: SessionUpdate[] }).events.push(u);
      },
      async getEvents(from?: number, to?: number) {
        return (this as unknown as { events: SessionUpdate[] }).events.slice(
          from,
          to,
        );
      },
      async count() {
        return (this as unknown as { events: SessionUpdate[] }).events.length;
      },
      systemPromptSection() {
        calls += 1;
        return `turn ${calls}`;
      },
    } as unknown as Session;

    const agent = await runAgent({
      name: "per-turn",
      tools: {},
      harness,
      session,
    });
    try {
      await agent.prompt("a");
      await agent.prompt("b");
      await agent.prompt("c");
      expect(calls).toBe(3);
    } finally {
      await agent.close();
    }
  });

  it("a thrown systemPromptSection doesn't kill the turn", async () => {
    let ran = false;
    const harness: Harness = {
      async run(rt: Runtime) {
        ran = true;
        const sp = rt.systemPrompt();
        // Section should be empty (the throw was caught and dropped).
        expect(sp).not.toContain("# Session");
        await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return { stopReason: "end_turn" as const };
      },
    };
    const session: Session = {
      events: [] as SessionUpdate[],
      async append(u: SessionUpdate) {
        (this as unknown as { events: SessionUpdate[] }).events.push(u);
      },
      async getEvents() {
        return [];
      },
      async count() {
        return 0;
      },
      systemPromptSection() {
        throw new Error("boom");
      },
    } as unknown as Session;

    const agent = await runAgent({
      name: "throw-test",
      tools: {},
      harness,
      session,
    });
    try {
      await agent.prompt("hi");
      expect(ran).toBe(true);
    } finally {
      await agent.close();
    }
  });
});
