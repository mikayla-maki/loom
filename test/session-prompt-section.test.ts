import { describe, expect, it } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import type {
  Agent,
  Harness,
  Runtime,
  Session,
} from "../src/types/interfaces.js";
import type { SessionUpdate } from "../src/types/acp.js";

/**
 * The Session can contribute a section to the assembled system prompt.
 * Loom calls `systemPromptSection(agent)` per turn, after
 * `prepareTurn`, passing a fresh `Agent` ref — nothing is bound at
 * boot.
 */

/**
 * Minimal storage session used by these tests. The `push`/`pull`
 * shape is the real Session contract; we only care here about the
 * `systemPromptSection` hook the caller injects.
 */
function makeSession(
  sectionOrThrow: string | ((agent: Agent) => string | Promise<string>),
): Session {
  const events: SessionUpdate[] = [];
  return {
    async push(u: SessionUpdate) {
      events.push(u);
      return [u];
    },
    async pull() {
      return events.slice();
    },
    systemPromptSection(agent) {
      return typeof sectionOrThrow === "function"
        ? sectionOrThrow(agent)
        : sectionOrThrow;
    },
  };
}

/** Trivial harness that records the assembled system prompt and ends the turn. */
function recordingHarness(): {
  harness: Harness;
  captured: () => string | null;
} {
  let captured: string | null = null;
  const harness: Harness = {
    async run(rt: Runtime) {
      captured = rt.systemPrompt();
      await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
      return { stopReason: "end_turn" as const };
    },
  };
  return { harness, captured: () => captured };
}

describe("Session.systemPromptSection", () => {
  it("contributes a section that lands in the assembled system prompt", async () => {
    const seenAgents: Agent[] = [];
    const session = makeSession((agent) => {
      seenAgents.push(agent);
      return "Recently retrieved memories: user prefers terse replies.";
    });
    const { harness, captured } = recordingHarness();

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
      expect(seenAgents[0]?.manifest.name).toBe("section-test");
      expect(captured()).not.toBeNull();
      expect(captured()!).toContain("# Session");
      expect(captured()!).toContain("user prefers terse replies");
    } finally {
      await agent.close();
    }
  });

  it("is called per turn with a fresh Agent ref", async () => {
    let calls = 0;
    const session = makeSession(() => `turn ${++calls}`);
    const harness: Harness = {
      async run(rt: Runtime) {
        // Read once so the section is realised.
        rt.systemPrompt();
        await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return { stopReason: "end_turn" as const };
      },
    };

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
    const session = makeSession(() => {
      throw new Error("boom");
    });

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
