import { describe, expect, it } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import type {
  Agent,
  Harness,
  Runtime,
  Session,
} from "../src/types/interfaces.js";
import type { SessionUpdate } from "../src/types/acp.js";

function makeSession(
  section: string | ((agent: Agent) => string | Promise<string>),
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
      return typeof section === "function" ? section(agent) : section;
    },
  };
}

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
  it("lands in the assembled prompt and is called per turn with a fresh Agent ref", async () => {
    const seenAgents: Agent[] = [];
    let calls = 0;
    const session = makeSession((agent) => {
      seenAgents.push(agent);
      return `Recently retrieved memories: user prefers terse replies. turn ${++calls}`;
    });
    const { harness, captured } = recordingHarness();

    const agent = await runAgent({
      name: "section-test",
      tools: {},
      harness,
      session,
    });
    try {
      await agent.prompt("a");
      expect(captured()!).toContain("# Session");
      expect(captured()!).toContain("user prefers terse replies");

      await agent.prompt("b");
      await agent.prompt("c");
      expect(calls).toBe(3);
      expect(seenAgents).toHaveLength(3);
      for (const seen of seenAgents) {
        expect(seen.harness).toBe(harness);
        expect(seen.session).toBe(session);
        expect(seen.manifest.name).toBe("section-test");
      }
    } finally {
      await agent.close();
    }
  });

  it("a thrown systemPromptSection doesn't kill the turn", async () => {
    const { harness, captured } = recordingHarness();
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
      // turn still ran, and the failed section was omitted from the prompt
      expect(captured()).not.toBeNull();
      expect(captured()!).not.toContain("# Session");
    } finally {
      await agent.close();
    }
  });
});
