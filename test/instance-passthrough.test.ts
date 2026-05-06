import { describe, expect, it } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import type {
  Harness,
  Provider,
  Runtime,
  Session,
  Tool,
} from "../src/types/interfaces.js";
import type { SessionUpdate, StopReason } from "../src/types/acp.js";

/**
 * Verifies that `runAgent` accepts pre-built `Harness` / `Session` /
 * `Provider` *instances* directly in the manifest, not just the
 * `{ provider: "name", ...config }` reference form. This is the path the
 * SDK consumer takes when building a custom CLI/TUI on top of Loom.
 */

describe("manifest accepts instances directly", () => {
  it("a Harness instance bypasses the registry lookup", async () => {
    let runs = 0;
    const harness: Harness = {
      async run(rt: Runtime): Promise<StopReason> {
        runs++;
        await rt.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi from instance" },
        });
        await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return "end_turn";
      },
    };

    const agent = await runAgent({
      name: "inst-harness",
      tools: {},
      harness, // ← raw instance, not { provider: "test" }
    });
    try {
      const stop = await agent.prompt("anything");
      expect(stop).toBe("end_turn");
      expect(runs).toBe(1);
      const events = await agent.session.getEvents();
      const said = events.find(
        (e) => e.sessionUpdate === "agent_message_chunk",
      );
      expect(said).toBeTruthy();
      if (said?.sessionUpdate === "agent_message_chunk") {
        expect(said.content.type === "text" && said.content.text).toBe(
          "hi from instance",
        );
      }
    } finally {
      await agent.close();
    }
  });

  it("a Session instance is used as-is (events flow through it)", async () => {
    const log: SessionUpdate[] = [];
    const session: Session = {
      async append(u) {
        log.push(u);
      },
      async getEvents() {
        return log.slice();
      },
      async count() {
        return log.length;
      },
    };

    const agent = await runAgent({
      name: "inst-session",
      tools: {},
      harness: { provider: "test", echo: true },
      session, // ← raw instance
    });
    try {
      await agent.prompt("ping");
      expect(log.some((e) => e.sessionUpdate === "user_message_chunk")).toBe(
        true,
      );
      expect(log.some((e) => e.sessionUpdate === "agent_message_chunk")).toBe(
        true,
      );
      // The Session instance is the same object the runtime drove.
      expect(agent.session).toBe(session);
    } finally {
      await agent.close();
    }
  });

  it("a Provider instance via RunAgentOptions.providers contributes tools", async () => {
    const stubTool: Tool = {
      name: "stub",
      description: "literal output",
      inputSchema: { type: "object" },
      async execute() {
        return { content: "stubbed!" };
      },
    };
    let closed = false;
    const provider: Provider = {
      async resolveTool(name) {
        if (name !== "stub") return null;
        return {
          kind: "synthetic",
          manifest: {
            name: "stub",
            description: "literal output",
            schema: { type: "object" },
            invocation: { command: "n/a" },
            capabilities: {},
          },
          tool: stubTool,
        };
      },
      resolveSkill: () => null,
      list: () => ({ tools: ["stub"] }),
      close: () => {
        closed = true;
      },
    };

    const agent = await runAgent(
      {
        name: "inst-provider",
        tools: {},
        harness: {
          provider: "test",
          script: [
            [{ call: { tool: "stub", input: {} } }, { stop: "end_turn" }],
          ],
        },
        skills: {
          s: { description: "uses stub", requires: { stub: "stub" } },
        },
      },
      { providers: [provider] }, // ← raw Provider instance, programmatic injection
    );
    try {
      await agent.prompt("go");
      const events = await agent.session.getEvents();
      const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
      expect(tu).toBeTruthy();
      if (tu?.sessionUpdate === "tool_call_update") {
        expect(tu.status).toBe("completed");
        const text =
          tu.content?.[0]?.type === "content" &&
          tu.content[0].content.type === "text"
            ? tu.content[0].content.text
            : "";
        expect(text).toContain("stubbed!");
      }
    } finally {
      await agent.close();
      // close() on the agent fans out to providers that expose it.
      expect(closed).toBe(true);
    }
  });
});
