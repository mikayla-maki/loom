import { describe, expect, it } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import type {
  Tools,
  Tool,
  ToolContext,
  ToolResult,
} from "../src/types/interfaces.js";
import type { AgentManifest } from "../src/types/manifest.js";

type CapturingProvider = Tools & { capturedCapabilities?: unknown };

function providerFor(...tools: Tool[]): CapturingProvider {
  const provider: CapturingProvider = {
    resolveTool(name, _config, _agent, capabilities) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) return null;
      provider.capturedCapabilities = capabilities;
      return tool;
    },
    close: () => {},
  };
  return provider;
}

describe("Tools extension — dynamic tool resolution", () => {
  it("serves provider tools by name and forwards input/output", async () => {
    let receivedInput: unknown = null;
    const shout: Tool = {
      name: "stub.shout",
      description: "Shout text from the provider's in-memory tool.",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" } },
      },
      async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
        receivedInput = input;
        return { content: String((input as { text: string }).text).toUpperCase() + "!" };
      },
    };
    const read: Tool = {
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

    const spec: AgentManifest = {
      name: "provider-agent",
      systemPrompt: "x",
      tools: { "stub.shout": "builtin", "fs.read": "builtin" },
      harness: {
        provider: "test",
        script: [
          [
            { call: { tool: "stub.shout", input: { text: "hi" } } },
            { call: { tool: "fs.read", input: { path: "/etc/hosts" } } },
            { stop: "end_turn" },
          ],
        ],
      },
    };

    const agent = await runAgent(spec, { providers: [providerFor(shout, read)] });
    try {
      await agent.prompt("go");
      const events = (await agent.session.pull?.([])) ?? [];
      const updates = events.filter((e) => e.sessionUpdate === "tool_call_update");
      expect(updates).toHaveLength(2);

      const texts = updates.map((u) =>
        u.sessionUpdate === "tool_call_update" &&
        u.status === "completed" &&
        u.content?.[0]?.type === "content" &&
        u.content[0].content.type === "text"
          ? u.content[0].content.text
          : "",
      );
      expect(texts).toEqual(["HI!", "read: /etc/hosts"]);
      expect(receivedInput).toEqual({ text: "hi" });
    } finally {
      await agent.close();
    }
  });

  it("fails boot when a provider tool's `requires` is not granted", async () => {
    const netTool: Tool = {
      name: "danger.net",
      description: "x",
      inputSchema: { type: "object" },
      requires: ["network"],
      async execute() {
        return { content: "noop" };
      },
    };
    const spec: AgentManifest = {
      name: "n",
      systemPrompt: "x",
      tools: { "danger.net": "builtin" },
      harness: { provider: "test" },
      capabilities: { "danger.net": {} },
    };
    await expect(
      runAgent(spec, { providers: [providerFor(netTool)] }),
    ).rejects.toThrow(/missing required.*network/);
  });

  it("passes the manifest grant to resolveTool's capabilities argument", async () => {
    const tool: Tool = {
      name: "observed",
      description: "x",
      inputSchema: { type: "object" },
      optional: ["foo"],
      async execute() {
        return { content: "" };
      },
    };
    const provider = providerFor(tool);
    const spec: AgentManifest = {
      name: "n",
      systemPrompt: "x",
      tools: { observed: "builtin" },
      harness: { provider: "test" },
      capabilities: { observed: { foo: ["a", "b"] } },
    };
    const agent = await runAgent(spec, { providers: [provider] });
    try {
      expect(provider.capturedCapabilities).toEqual({ foo: ["a", "b"] });
    } finally {
      await agent.close();
    }
  });
});
