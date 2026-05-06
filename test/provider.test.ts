import { describe, expect, it } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import type {
  Provider,
  ProviderSkillResolution,
  ProviderToolResolution,
  Tool,
  ToolResult,
} from "../src/types/interfaces.js";
import type {
  AgentManifest,
  ToolCapabilities,
  ToolManifest,
} from "../src/types/manifest.js";
import { auditAgent } from "../src/audit/audit.js";

/**
 * Build a synthetic ToolManifest the resolver will accept. Most fields are
 * dummies: a provider-supplied tool never spawns a process, so command/cwd
 * are unused. capabilities still bubble up to the [sandbox] check though.
 */
function syntheticToolManifest(opts: {
  name: string;
  description: string;
  capabilities?: ToolCapabilities;
}): ToolManifest {
  return {
    manifestPath: `synthetic://${opts.name}`,
    toolDir: `synthetic://${opts.name}`,
    name: opts.name,
    description: opts.description,
    schema: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
    },
    invocation: { command: "(synthetic)", args: [] },
    secrets: { required: [] },
    capabilities: opts.capabilities ?? { filesystem: [], network: [] },
    shipsBinary: false,
  };
}

describe("Provider extension — dynamic tool/skill resolution", () => {
  it("a programmatic provider supplies a tool the model uses", async () => {
    let receivedInput: unknown = null;
    class StubTool implements Tool {
      name = "stub.shout";
      description = "Shout text from the provider's in-memory tool.";
      inputSchema = {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" } },
      };
      async execute(
        input: unknown,
        _secrets: Record<string, string>,
      ): Promise<ToolResult> {
        receivedInput = input;
        const text = String((input as { text: string }).text);
        return { content: text.toUpperCase() + "!" };
      }
    }

    const provider: Provider = {
      resolveTool: (name) => {
        if (name === "stub:shout") {
          const r: ProviderToolResolution = {
            kind: "synthetic",
            manifest: syntheticToolManifest({
              name: "stub.shout",
              description: "shout",
            }),
            tool: new StubTool(),
          };
          return r;
        }
        return null;
      },
      resolveSkill: () => null,
      list: () => ({}),
      close: () => {},
    };

    // Inline parent agent. The "shout" skill references the tool by the
    // provider's bare name, exactly as it would on disk.
    const spec: AgentManifest = {
      name: "provider-agent",
      systemPrompt: "x",
      tools: {},
      harness: {
        provider: "test",
        script: [
          [
            { call: { tool: "stub.shout", input: { text: "hi" } } },
            { stop: "end_turn" },
          ],
        ],
      },
      sandbox: { filesystem: [], network: [], secrets: [] },
      skills: {
        shout: {
          description: "Provider-backed shout",
          requires: { "stub.shout": "stub:shout" },
        },
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

  it("a provider supplies a synthetic skill with multiple bundled tools", async () => {
    class FsSearch implements Tool {
      name = "fs.search";
      description = "Search files (synthetic).";
      inputSchema = {
        type: "object",
        required: ["q"],
        properties: { q: { type: "string" } },
      };
      async execute(input: unknown): Promise<ToolResult> {
        return { content: `searched: ${(input as { q: string }).q}` };
      }
    }
    class FsRead implements Tool {
      name = "fs.read";
      description = "Read a file (synthetic).";
      inputSchema = {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
      };
      async execute(input: unknown): Promise<ToolResult> {
        return { content: `read: ${(input as { path: string }).path}` };
      }
    }

    const provider: Provider = {
      resolveSkill: (name): ProviderSkillResolution | null => {
        if (name !== "mcp:filesystem") return null;
        const tools = new Map<string, { manifest: ToolManifest; tool: Tool }>();
        tools.set("fs.search", {
          manifest: syntheticToolManifest({
            name: "fs.search",
            description: "search",
          }),
          tool: new FsSearch(),
        });
        tools.set("fs.read", {
          manifest: syntheticToolManifest({
            name: "fs.read",
            description: "read",
          }),
          tool: new FsRead(),
        });
        return {
          kind: "synthetic",
          manifest: {
            manifestPath: "synthetic://skills/mcp:filesystem",
            skillDir: "synthetic://skills/mcp:filesystem",
            name: "mcp-filesystem",
            description: "MCP filesystem server (synthetic)",
            body: "Synthetic skill bundling provider-supplied tools.",
            requires: { "fs.search": "<provider>", "fs.read": "<provider>" },
          },
          tools,
        };
      },
      resolveTool: () => null,
      list: () => ({}),
      close: () => {},
    };

    // The skill reference itself is the provider name `mcp:filesystem`;
    // the parent agent stays inline.
    const spec: AgentManifest = {
      name: "skill-provider-agent",
      systemPrompt: "x",
      tools: {},
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
      sandbox: { filesystem: [], network: [], secrets: [] },
      skills: { fs: "mcp:filesystem" },
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

  // Removed: "a manifest-declared provider boots from [providers] table and
  // gets close()'d". The [providers] table is gone (everything lives under
  // [extensions] now), and [extensions] entries resolve as npm packages —
  // the in-process registered-factory lookup path the old test depended on
  // doesn't exist for manifest-declared providers. Programmatic providers
  // via `runAgent(spec, { providers: [...] })` are still covered by the
  // sibling tests in this describe block.

  it("provider-supplied tool capabilities still get checked against the [sandbox] ceiling", async () => {
    const provider: Provider = {
      resolveTool: (name) =>
        name === "danger:net"
          ? {
              kind: "synthetic",
              manifest: syntheticToolManifest({
                name: "danger.net",
                description: "x",
                capabilities: { network: ["evil.com"], filesystem: [] },
              }),
              tool: {
                name: "danger.net",
                description: "x",
                inputSchema: { type: "object" },
                async execute() {
                  return { content: "noop" };
                },
              },
            }
          : null,
      resolveSkill: () => null,
      list: () => ({}),
      close: () => {},
    };

    const spec: AgentManifest = {
      name: "n",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test" },
      sandbox: { filesystem: [], network: [], secrets: [] },
      skills: {
        d: {
          description: "dangerous",
          requires: { "danger.net": "danger:net" },
        },
      },
    };
    await expect(
      runAgent(spec, {
        providers: [provider],
      }),
    ).rejects.toThrow(/exceed|ceiling/i);
  });

  it("auditAgent reflects provider-supplied tools", async () => {
    const provider: Provider = {
      resolveTool: (name) =>
        name === "demo:tool"
          ? {
              kind: "synthetic",
              manifest: syntheticToolManifest({
                name: "demo.tool",
                description: "x",
              }),
              tool: {
                name: "demo.tool",
                description: "x",
                inputSchema: { type: "object" },
                async execute() {
                  return { content: "" };
                },
              },
            }
          : null,
      resolveSkill: () => null,
      list: () => ({}),
      close: () => {},
    };
    const spec: AgentManifest = {
      name: "audit-prov",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test" },
      sandbox: { filesystem: [], network: [], secrets: [] },
      skills: {
        x: {
          description: "x",
          requires: { "demo.tool": "demo:tool" },
        },
      },
    };
    const tree = await auditAgent(spec, { providers: [provider] });
    expect(tree.tools.map((t) => t.name)).toEqual(["demo.tool"]);
  });
});
