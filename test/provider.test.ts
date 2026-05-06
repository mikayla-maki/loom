import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { runAgent } from "../src/sdk/run-agent.js";
import { memorySessionFactory } from "../src/extensions/session/memory.js";
import { testHarnessFactory } from "../src/extensions/harness/test.js";
import { registerProvider } from "../src/extensions/index.js";
import type {
  Provider,
  ProviderFactory,
  ProviderSkillResolution,
  ProviderToolResolution,
  Tool,
  ToolResult,
} from "../src/types/interfaces.js";
import type { ToolManifest } from "../src/types/manifest.js";
import { auditAgent } from "../src/audit/audit.js";

/**
 * Build a synthetic ToolManifest the resolver will accept. Most fields are
 * dummies: a provider-supplied tool never spawns a process, so command/cwd
 * are unused. capabilities still bubble up to the [sandbox] check though.
 */
function syntheticToolManifest(opts: {
  name: string;
  description: string;
  capabilities?: ToolManifest["tool"]["capabilities"];
}): ToolManifest {
  return {
    manifestPath: `synthetic://${opts.name}`,
    toolDir: `synthetic://${opts.name}`,
    tool: {
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
    },
    shipsBinary: false,
  };
}

describe("Provider extension — dynamic tool/skill resolution", () => {
  it("a programmatic provider supplies a tool the model uses", async () => {
    let receivedInput: unknown = null;
    class StubTool implements Tool {
      name = "stub.shout";
      description = "Shout text from the provider's in-memory tool.";
      inputSchema = { type: "object", required: ["text"], properties: { text: { type: "string" } } };
      async execute(input: unknown, _secrets: Record<string, string>): Promise<ToolResult> {
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
            manifest: syntheticToolManifest({ name: "stub.shout", description: "shout" }),
            tool: new StubTool(),
          };
          return r;
        }
        return null;
      },
    };

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "glass-provider-"));
    try {
      // SKILL.md `requires` references the tool by the provider's bare name.
      const skillDir = path.join(root, "skills", "shout");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: shout
description: Provider-backed shout
requires:
  stub.shout: stub:shout
---
body
`,
      );
      const agentDir = path.join(root, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "provider-agent"
identity_inline = "x"
[harness]
provider = "test"
[session]
provider = "memory"
[sandbox]
filesystem = []
network = []
secrets = []
[skills]
s = "../skills/shout"
`,
      );

      const agent = await runAgent(path.join(agentDir, "agent.toml"), {
        sessionOverride: memorySessionFactory,
        harnessOverride: {
          factory: testHarnessFactory,
          config: {
            script: [
              [
                { call: { tool: "stub.shout", input: { text: "hi" } } },
                { stop: "end_turn" },
              ],
            ],
          },
        },
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
            tu.content?.[0]?.type === "content" && tu.content[0].content.type === "text"
              ? tu.content[0].content.text
              : "";
          expect(text).toBe("HI!");
        }
        expect(receivedInput).toEqual({ text: "hi" });
      } finally {
        await agent.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("a provider supplies a synthetic skill with multiple bundled tools", async () => {
    class FsSearch implements Tool {
      name = "fs.search";
      description = "Search files (synthetic).";
      inputSchema = { type: "object", required: ["q"], properties: { q: { type: "string" } } };
      async execute(input: unknown): Promise<ToolResult> {
        return { content: `searched: ${(input as { q: string }).q}` };
      }
    }
    class FsRead implements Tool {
      name = "fs.read";
      description = "Read a file (synthetic).";
      inputSchema = { type: "object", required: ["path"], properties: { path: { type: "string" } } };
      async execute(input: unknown): Promise<ToolResult> {
        return { content: `read: ${(input as { path: string }).path}` };
      }
    }

    const provider: Provider = {
      resolveSkill: (name): ProviderSkillResolution | null => {
        if (name !== "mcp:filesystem") return null;
        const tools = new Map<string, { manifest: ToolManifest; tool: Tool }>();
        tools.set("fs.search", { manifest: syntheticToolManifest({ name: "fs.search", description: "search" }), tool: new FsSearch() });
        tools.set("fs.read", { manifest: syntheticToolManifest({ name: "fs.read", description: "read" }), tool: new FsRead() });
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
    };

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "glass-skill-prov-"));
    try {
      const agentDir = path.join(root, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "skill-provider-agent"
identity_inline = "x"
[harness]
provider = "test"
[session]
provider = "memory"
[sandbox]
filesystem = []
network = []
secrets = []
[skills]
fs = "mcp:filesystem"
`,
      );

      const agent = await runAgent(path.join(agentDir, "agent.toml"), {
        sessionOverride: memorySessionFactory,
        harnessOverride: {
          factory: testHarnessFactory,
          config: {
            script: [
              [
                { call: { tool: "fs.search", input: { q: "needle" } } },
                { call: { tool: "fs.read", input: { path: "/etc/hosts" } } },
                { stop: "end_turn" },
              ],
            ],
          },
        },
        providers: [provider],
      });
      try {
        await agent.prompt("go");
        const events = await agent.session.getEvents();
        const updates = events.filter((e) => e.sessionUpdate === "tool_call_update");
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
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("a manifest-declared provider boots from [providers] table and gets close()'d", async () => {
    const events: string[] = [];
    let booted = false;
    class StubTool implements Tool {
      name = "demo.echo";
      description = "echo";
      inputSchema = { type: "object", required: ["text"], properties: { text: { type: "string" } } };
      async execute(input: unknown): Promise<ToolResult> {
        events.push("execute");
        return { content: String((input as { text: string }).text) };
      }
    }
    const factory: ProviderFactory = {
      name: "fake-provider-ext",
      create: async (config) => {
        events.push(`create:${JSON.stringify(config)}`);
        booted = true;
        const provider: Provider = {
          resolveTool: (name) =>
            name === "fake:echo"
              ? {
                  kind: "synthetic",
                  manifest: syntheticToolManifest({ name: "demo.echo", description: "echo" }),
                  tool: new StubTool(),
                }
              : null,
          close: async () => {
            events.push("close");
          },
        };
        return provider;
      },
    };
    registerProvider(factory);

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "glass-mfact-prov-"));
    try {
      const skillDir = path.join(root, "skills", "echo");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: echo
description: echo skill via provider
requires:
  demo.echo: fake:echo
---
body
`,
      );
      const agentDir = path.join(root, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "manifest-provider-agent"
identity_inline = "x"
[harness]
provider = "test"
[session]
provider = "memory"
[sandbox]
filesystem = []
network = []
secrets = []
[providers]
fake-provider-ext = { greeting = "hi" }
[skills]
e = "../skills/echo"
`,
      );

      const agent = await runAgent(path.join(agentDir, "agent.toml"), {
        sessionOverride: memorySessionFactory,
        harnessOverride: {
          factory: testHarnessFactory,
          config: {
            script: [
              [{ call: { tool: "demo.echo", input: { text: "yo" } } }, { stop: "end_turn" }],
            ],
          },
        },
      });
      try {
        await agent.prompt("go");
        expect(booted).toBe(true);
        expect(events.some((e) => e.startsWith("create:"))).toBe(true);
        expect(events).toContain("execute");
      } finally {
        await agent.close();
      }
      // close() must propagate to providers
      expect(events).toContain("close");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

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
    };

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "glass-prov-cap-"));
    try {
      const skillDir = path.join(root, "skills", "d");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: d
description: dangerous
requires:
  danger.net: danger:net
---
body`,
      );
      const agentDir = path.join(root, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "n"
identity_inline = "x"
[harness]
provider = "test"
[session]
provider = "memory"
[sandbox]
filesystem = []
network = []
secrets = []
[skills]
d = "../skills/d"
`,
      );
      await expect(
        runAgent(path.join(agentDir, "agent.toml"), {
          providers: [provider],
        }),
      ).rejects.toThrow(/exceed|ceiling/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("auditAgent reflects provider-supplied tools", async () => {
    const provider: Provider = {
      resolveTool: (name) =>
        name === "demo:tool"
          ? {
              kind: "synthetic",
              manifest: syntheticToolManifest({ name: "demo.tool", description: "x" }),
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
    };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "glass-prov-audit-"));
    try {
      const skillDir = path.join(root, "skills", "x");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: x
description: x
requires:
  demo.tool: demo:tool
---
body`,
      );
      const agentDir = path.join(root, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "audit-prov"
identity_inline = "x"
[harness]
provider = "test"
[session]
provider = "memory"
[sandbox]
filesystem = []
network = []
secrets = []
[skills]
x = "../skills/x"
`,
      );
      const tree = await auditAgent(path.join(agentDir, "agent.toml"), {
        providers: [provider],
      });
      expect(tree.tools.map((t) => t.name)).toEqual(["demo.tool"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
