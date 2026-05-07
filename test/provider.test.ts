import { describe, expect, it } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import type {
  Provider,
  Tool,
  ToolContext,
  ToolResult,
} from "../src/types/interfaces.js";
import type { AgentManifest } from "../src/types/manifest.js";

describe("Provider extension — dynamic tool resolution", () => {
  it("a programmatic provider supplies a tool the model uses", async () => {
    let receivedInput: unknown = null;
    const stubTool: Tool = {
      name: "stub.shout",
      description: "Shout text from the provider's in-memory tool.",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" } },
      },
      async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
        receivedInput = input;
        const text = String((input as { text: string }).text);
        return { content: text.toUpperCase() + "!" };
      },
    };

    const provider: Provider = {
      resolveTool(name) {
        if (name === "stub.shout") return stubTool;
        return null;
      },
      close: () => {},
    };

    // Inline parent agent. The provider claims `stub.shout` from
    // [tools]; the harness can call it by name.
    const spec: AgentManifest = {
      name: "provider-agent",
      systemPrompt: "x",
      tools: { "stub.shout": {} },
      harness: {
        provider: "test",
        script: [
          [
            { call: { tool: "stub.shout", input: { text: "hi" } } },
            { stop: "end_turn" },
          ],
        ],
      },
    };

    const agent = await runAgent(spec, {
      providers: [provider],
    });
    try {
      await agent.prompt("go");
      const events = await agent.session.getEvents();
      const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
      expect(tu).toBeTruthy();
      if (tu && tu.sessionUpdate === "tool_call_update") {
        expect(tu.status).toBe("completed");
        const text =
          tu.content?.[0]?.type === "content" &&
          tu.content[0].content.type === "text"
            ? tu.content[0].content.text
            : "";
        expect(text).toBe("HI!");
      }
      expect(receivedInput).toEqual({ text: "hi" });
    } finally {
      await agent.close();
    }
  });

  it("a provider serves multiple tools by name", async () => {
    const fsSearch: Tool = {
      name: "fs.search",
      description: "Search files (synthetic).",
      inputSchema: {
        type: "object",
        required: ["q"],
        properties: { q: { type: "string" } },
      },
      async execute(input) {
        return { content: `searched: ${(input as { q: string }).q}` };
      },
    };
    const fsRead: Tool = {
      name: "fs.read",
      description: "Read a file (synthetic).",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
      },
      async execute(input) {
        return { content: `read: ${(input as { path: string }).path}` };
      },
    };

    const provider: Provider = {
      resolveTool(name) {
        if (name === "fs.search") return fsSearch;
        if (name === "fs.read") return fsRead;
        return null;
      },
      close: () => {},
    };

    const spec: AgentManifest = {
      name: "skill-provider-agent",
      systemPrompt: "x",
      tools: { "fs.search": {}, "fs.read": {} },
      harness: {
        provider: "test",
        script: [
          [
            { call: { tool: "fs.search", input: { q: "needle" } } },
            { call: { tool: "fs.read", input: { path: "/etc/hosts" } } },
            { stop: "end_turn" },
          ],
        ],
      },
    };

    const agent = await runAgent(spec, {
      providers: [provider],
    });
    try {
      await agent.prompt("go");
      const events = await agent.session.getEvents();
      const updates = events.filter(
        (e) => e.sessionUpdate === "tool_call_update",
      );
      expect(updates).toHaveLength(2);

      const texts = updates.map((u) =>
        u.sessionUpdate === "tool_call_update" &&
        u.content?.[0]?.type === "content" &&
        u.content[0].content.type === "text"
          ? u.content[0].content.text
          : "",
      );
      expect(texts).toEqual(["searched: needle", "read: /etc/hosts"]);
    } finally {
      await agent.close();
    }
  });

  it("provider-supplied tool capabilities still get checked against the [capabilities] ceiling", async () => {
    const dangerTool: Tool = {
      name: "danger.net",
      description: "x",
      inputSchema: { type: "object" },
      capabilities: { hosts: ["evil.com"] },
      async execute() {
        return { content: "noop" };
      },
    };
    const provider: Provider = {
      resolveTool(name) {
        if (name === "danger.net") return dangerTool;
        return null;
      },
      close: () => {},
    };

    const spec: AgentManifest = {
      name: "n",
      systemPrompt: "x",
      tools: { "danger.net": {} },
      harness: { provider: "test" },
      // Per-tool ceiling: danger.net may only reach `safe.com`. The
      // tool's declared `evil.com` exceeds it → boot fails.
      capabilities: { "danger.net": { hosts: ["safe.com"] } },
    };
    await expect(
      runAgent(spec, {
        providers: [provider],
      }),
    ).rejects.toThrow(/exceed|ceiling/i);
  });
});
