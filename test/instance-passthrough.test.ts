import { describe, expect, it } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import type {
  Harness,
  Tools,
  Runtime,
  Session,
  Tool,
} from "../src/types/interfaces.js";
import type { SessionUpdate } from "../src/types/acp.js";

describe("manifest accepts instances directly", () => {
  it("a Harness instance bypasses the registry lookup", async () => {
    let runs = 0;
    const harness: Harness = {
      async run(rt: Runtime) {
        runs++;
        await rt.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi from instance" },
        });
        await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return { stopReason: "end_turn" as const };
      },
    };

    const agent = await runAgent({ name: "inst-harness", tools: {}, harness });
    try {
      const result = await agent.prompt("anything");
      expect(result.stopReason).toBe("end_turn");
      expect(runs).toBe(1);
      const events = (await agent.session.pull?.([])) ?? [];
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
      async push(u) {
        log.push(u);
        return [u];
      },
      async pull() {
        return log.slice();
      },
    };

    const agent = await runAgent({
      name: "inst-session",
      tools: {},
      harness: { provider: "test", echo: true },
      session,
    });
    try {
      await agent.prompt("ping");
      expect(log.some((e) => e.sessionUpdate === "user_message_chunk")).toBe(
        true,
      );
      expect(log.some((e) => e.sessionUpdate === "agent_message_chunk")).toBe(
        true,
      );
      expect(agent.session).toBe(session);
    } finally {
      await agent.close();
    }
  });

  it("a session array mixes pre-built instances with named layers", async () => {
    const captured: SessionUpdate[] = [];
    const outer: Session = {
      async push(u) {
        captured.push(u);
        return [u];
      },
      async pull(below) {
        return below;
      },
    };

    const agent = await runAgent({
      name: "inst-session-mix",
      tools: {},
      harness: { provider: "test", echo: true },
      session: [outer, "in-memory"],
    });
    try {
      await agent.prompt("hello");
      expect(
        captured.some((e) => e.sessionUpdate === "user_message_chunk"),
      ).toBe(true);
      expect(
        captured.some((e) => e.sessionUpdate === "agent_message_chunk"),
      ).toBe(true);
      const events = (await agent.session.pull?.([])) ?? [];
      expect(events.some((e) => e.sessionUpdate === "user_message_chunk")).toBe(
        true,
      );
    } finally {
      await agent.close();
    }
  });

  it("a Tools instance via RunAgentOptions.providers contributes tools", async () => {
    const stubTool: Tool = {
      name: "stub",
      description: "literal output",
      inputSchema: { type: "object" },
      async execute() {
        return { content: "stubbed!" };
      },
    };
    let closed = false;
    const provider: Tools = {
      resolveTool(name) {
        if (name === "stub") return stubTool;
        return null;
      },
      close: () => {
        closed = true;
      },
    };

    const agent = await runAgent(
      {
        name: "inst-provider",
        tools: { stub: "builtin" },
        harness: {
          provider: "test",
          script: [
            [{ call: { tool: "stub", input: {} } }, { stop: "end_turn" }],
          ],
        },
      },
      { providers: [provider] },
    );
    try {
      await agent.prompt("go");
      const events = (await agent.session.pull?.([])) ?? [];
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
      expect(closed).toBe(true);
    }
  });
});
