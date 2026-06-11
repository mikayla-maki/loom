import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import {
  McpServerTools,
  mcpServerToolsFactory,
} from "../src/builtins/tools/mcp.js";
import { DEFAULT_CLIENT_ACP_CAPABILITIES } from "../src/runtime/acp-capabilities.js";
import { ManifestError } from "../src/errors.js";
import { runAgent } from "../src/sdk/run-agent.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import type { FactoryContext, InitArgs } from "../src/types/interfaces.js";
import type { AgentManifest } from "../src/types/manifest.js";
import { defined } from "./helpers/assert.js";

const FIXTURES = path.resolve("test/fixtures");
const ECHO_SERVER = path.join(FIXTURES, "mcp/echo-server.mjs");
const ENV_SERVER = path.join(FIXTURES, "mcp/env-server.mjs");

function ctx(overrides: Partial<FactoryContext> = {}): FactoryContext {
  return {
    manifestDir: process.cwd(),
    agentName: "test-agent",
    loomVersion: "0.0.0-test",
    clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
    storage: path.join(process.cwd(), ".loom-test-storage"),
    metadata: {},
    ...overrides,
  };
}

function emptyManifest(): AgentManifest {
  return {
    name: "test-agent",
    harness: { provider: "test" },
  };
}

function initArgs(config: Record<string, unknown>): InitArgs {
  return {
    manifest: emptyManifest(),
    config,
    secrets: {},
    factoryContext: ctx(),
    runtime: {
      async requestPermission() {
        throw new Error("not used in MCP factory tests");
      },
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((e as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

function echoTools(): McpServerTools {
  return mcpServerToolsFactory.create(
    { command: process.execPath, args: [ECHO_SERVER] },
    ctx(),
    {},
    undefined,
  ) as McpServerTools;
}

async function withEchoTools(
  body: (tools: McpServerTools) => Promise<void>,
): Promise<void> {
  const tools = echoTools();
  await tools.init(
    initArgs({ command: process.execPath, args: [ECHO_SERVER] }),
  );
  try {
    await body(tools);
  } finally {
    await tools.close();
  }
}

async function withAgent(
  spec: AgentManifest,
  opts: Parameters<typeof runAgent>[1],
  body: (agent: Awaited<ReturnType<typeof runAgent>>) => Promise<void>,
): Promise<void> {
  const agent = await runAgent(spec, opts);
  try {
    await body(agent);
  } finally {
    await agent.close();
  }
}

function echoServerSpec(
  name: string,
  tools: AgentManifest["tools"],
  capabilities: AgentManifest["capabilities"],
): AgentManifest {
  return {
    name,
    systemPrompt: "x",
    harness: { provider: "test" },
    providers: {
      echo_mcp: {
        provider: "mcp-server",
        command: process.execPath,
        args: [ECHO_SERVER],
      },
    },
    tools,
    capabilities,
  };
}

function envServerSpec(name: string): AgentManifest {
  return {
    name,
    systemPrompt: "x",
    harness: { provider: "test" },
    providers: {
      env_mcp: {
        provider: "mcp-server",
        command: process.execPath,
        args: [ENV_SERVER],
        secrets: { MOCK_API_KEY: "MOCK_API_KEY" },
      },
    },
    tools: {
      whoami: { provider: "env_mcp" },
    },
    capabilities: { whoami: "*" },
  };
}

describe("mcp-server factory — config parsing", () => {
  it("rejects an empty config", () => {
    expect(() =>
      mcpServerToolsFactory.create({}, ctx(), {}, undefined),
    ).toThrow(ManifestError);
    expect(() =>
      mcpServerToolsFactory.create({}, ctx(), {}, undefined),
    ).toThrow(/'command' or 'npm'/);
  });

  it("rejects when both command and npm are set", () => {
    expect(() =>
      mcpServerToolsFactory.create(
        { command: "node", npm: "@x/y" },
        ctx(),
        {},
        undefined,
      ),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects non-string args", () => {
    expect(() =>
      mcpServerToolsFactory.create(
        { command: "node", args: ["ok", 42 as unknown as string] },
        ctx(),
        {},
        undefined,
      ),
    ).toThrow(/array of strings/);
  });

  it("rejects a non-string env table", () => {
    expect(() =>
      mcpServerToolsFactory.create(
        { command: "node", env: { OK: "a", BAD: 1 as unknown as string } },
        ctx(),
        {},
        undefined,
      ),
    ).toThrow(/string->string/);
  });

  it("constructs without spawning (the spawn happens at init)", () => {
    const tools = mcpServerToolsFactory.create(
      { command: "node", args: [ECHO_SERVER] },
      ctx(),
      {},
      undefined,
    );
    expect(tools).toBeInstanceOf(McpServerTools);
  });
});

describe("mcp-server factory — lifecycle", () => {
  it("spawns the server, completes the handshake, surfaces serverInfo, and reaps the child on close()", async () => {
    const tools = echoTools();
    await tools.init(
      initArgs({ command: process.execPath, args: [ECHO_SERVER] }),
    );

    const info = defined(tools.serverInfo, "serverInfo not populated");
    expect(info.name).toBe("loom-test-mcp-echo");
    expect(info.version).toBe("0.0.1");
    expect(info.capabilities).toMatchObject({ tools: {} });

    const proc = (tools.transport as unknown as { _process?: { pid?: number } })
      ._process;
    const pid = defined(
      defined(proc, "transport._process missing").pid,
      "process pid missing",
    );
    expect(typeof pid).toBe("number");
    expect(isAlive(pid)).toBe(true);

    expect(
      tools.resolveTool("not_a_real_tool", {}, {} as never, undefined),
    ).toBeNull();

    await tools.close();

    let alive = isAlive(pid);
    for (let i = 0; i < 20 && alive; i++) {
      await wait(50);
      alive = isAlive(pid);
    }
    expect(alive).toBe(false);

    await tools.close();
    await tools.close();
  });

  it("close() before init() is a no-op", async () => {
    await echoTools().close();
  });
});

describe("mcp-server factory — tool resolution + execution", () => {
  it("caches the tools/list result, resolves discovered tools, executes them, and supports the `tool` rename", async () => {
    await withEchoTools(async (tools) => {
      expect([...tools.toolsCache.keys()].sort()).toEqual(["add", "echo"]);

      const echo = defined(
        tools.resolveTool("echo", {}, {} as never, undefined),
        "resolveTool('echo') returned null",
      );
      expect(echo.name).toBe("echo");
      expect(echo.description).toMatch(/Return the input verbatim/);
      expect((echo.inputSchema as { properties?: unknown }).properties).toEqual(
        { text: expect.objectContaining({ type: "string" }) },
      );

      const echoed = await echo.execute({ text: "hello loom" }, {} as never);
      expect(echoed.isError).toBeUndefined();
      expect(echoed.content).toBe("hello loom");

      const say = defined(
        tools.resolveTool("say", { tool: "echo" }, {} as never, undefined),
        "resolveTool('say') returned null",
      );
      expect(say.name).toBe("say");
      const renamed = await say.execute({ text: "renamed!" }, {} as never);
      expect(renamed.content).toBe("renamed!");
    });
  });

  it("appends a secrets-safe host note listing pre-bound args, and omits it when nothing is narrowed", async () => {
    await withEchoTools(async (tools) => {
      const plain = defined(
        tools.resolveTool("add", {}, {} as never, undefined),
        "resolveTool('add', no grant) returned null",
      );
      expect(plain.description).toBe("Add two integers.");
      expect(plain.description).not.toContain("Host note");

      const bound = defined(
        tools.resolveTool("add", {}, {} as never, { a: 10, b: "*" }),
        "resolveTool('add', bound a) returned null",
      );
      expect(bound.description).toContain("Add two integers.");
      expect(bound.description).toContain("Host note");
      expect(bound.description).toContain("`a`");
      expect(bound.description).toContain("pre-configured");
      expect(bound.description).not.toContain("10");

      const bound2 = defined(
        tools.resolveTool("add", {}, {} as never, { a: 10, b: 20 }),
        "resolveTool('add', bound a+b) returned null",
      );
      expect(bound2.description).toContain("`a`");
      expect(bound2.description).toContain("`b`");
      expect(bound2.description).toMatch(/arguments are/);

      const starred = defined(
        tools.resolveTool("add", {}, {} as never, "*"),
        "resolveTool('add', '*' grant) returned null",
      );
      expect(starred.description).not.toContain("Host note");
    });
  });

  it("a per-arg map grant is a closed whitelist at execute time: dropped args can't be re-supplied", async () => {
    await withEchoTools(async (tools) => {
      // Grant names only `a`, deliberately withholding `b` from the model.
      const narrowed = defined(
        tools.resolveTool("add", {}, {} as never, { a: "*" }),
        "resolveTool('add', { a: '*' }) returned null",
      );
      // The model-facing schema hides `b`...
      expect(
        Object.keys(
          (narrowed.inputSchema as { properties: Record<string, unknown> })
            .properties,
        ),
      ).toEqual(["a"]);
      // ...and re-supplying `b` is rejected rather than forwarded to the server.
      const reSupplied = await narrowed.execute(
        { a: 5, b: 100 },
        {} as never,
      );
      expect(reSupplied.isError).toBe(true);
      expect(reSupplied.content).toMatch(/'b' is not permitted/);

      // A whole-tool `*`/undefined grant does NOT narrow, so an open schema
      // still forwards every argument verbatim (no false positives).
      const open = defined(
        tools.resolveTool("add", {}, {} as never, undefined),
        "resolveTool('add', undefined) returned null",
      );
      const summed = await open.execute({ a: 5, b: 100 }, {} as never);
      expect(summed.isError).toBeUndefined();
      expect(summed.content).toBe("105");
    });
  });

  it("rejects a non-string `tool` config value", async () => {
    await withEchoTools(async (tools) => {
      expect(() =>
        tools.resolveTool(
          "foo",
          { tool: 42 as unknown as string },
          {} as never,
          undefined,
        ),
      ).toThrow(/'tool'.*must be a non-empty string/);
    });
  });
});

describe("mcp-server factory — end-to-end through runAgent", () => {
  it("boots [providers] → [tools] and executes against the live MCP server", async () => {
    const spec = echoServerSpec(
      "mcp-e2e",
      { echo: { provider: "echo_mcp" } },
      { echo: "*" },
    );
    await withAgent(spec, {}, async (agent) => {
      const names = agent.agentState.toolTable.list().map((t) => t.name);
      expect(names).toEqual(["echo"]);
      const result = await agent.agentState.toolTable.execute({
        id: "call-1",
        name: "echo",
        input: { text: "hello from runAgent" },
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toBe("hello from runAgent");
    });
  });

  it("exposes one MCP tool under multiple model-facing names via the `tool` rename", async () => {
    const spec = echoServerSpec(
      "mcp-rename-e2e",
      {
        echo: { provider: "echo_mcp" },
        say: { provider: "echo_mcp", tool: "echo" },
        shout: { provider: "echo_mcp", tool: "echo" },
      },
      { echo: "*", say: "*", shout: "*" },
    );
    await withAgent(spec, {}, async (agent) => {
      const names = agent.agentState.toolTable
        .list()
        .map((t) => t.name)
        .sort();
      expect(names).toEqual(["echo", "say", "shout"]);
      const a = await agent.agentState.toolTable.execute({
        id: "a",
        name: "say",
        input: { text: "hi" },
      });
      const b = await agent.agentState.toolTable.execute({
        id: "b",
        name: "shout",
        input: { text: "HI" },
      });
      expect(a.content).toBe("hi");
      expect(b.content).toBe("HI");
    });
  });

  it("partial-applies a bound arg the model never sees, narrowing the schema", async () => {
    const spec = echoServerSpec(
      "mcp-bind-e2e",
      { add_to_10: { provider: "echo_mcp", tool: "add" } },
      { add_to_10: { a: 10, b: "*" } },
    );
    await withAgent(spec, {}, async (agent) => {
      const list = agent.agentState.toolTable.list();
      expect(list).toHaveLength(1);
      const t = defined(list[0], "toolTable.list() returned empty");
      const props = (t.inputSchema as { properties: Record<string, unknown> })
        .properties;
      expect(Object.keys(props)).toEqual(["b"]);
      expect((t.inputSchema as { required: string[] }).required).toEqual(["b"]);
      const result = await agent.agentState.toolTable.execute({
        id: "call",
        name: "add_to_10",
        input: { b: 7 },
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toBe("17");
    });
  });

  it("rejects (isError, not throw) a model attempt to override a bound arg", async () => {
    const spec = echoServerSpec(
      "mcp-bind-override-e2e",
      { bound_echo: { provider: "echo_mcp", tool: "echo" } },
      { bound_echo: { text: "locked-value" } },
    );
    await withAgent(spec, {}, async (agent) => {
      const result = await agent.agentState.toolTable.execute({
        id: "call",
        name: "bound_echo",
        input: { text: "attempted override" },
      });
      expect(result.isError).toBe(true);
    });
  });

  it("injects a Loom secret into the MCP child's env", async () => {
    await withAgent(
      envServerSpec("mcp-secret-e2e"),
      { secrets: new StaticSecretsStore({ MOCK_API_KEY: "sek-ret-9000" }) },
      async (agent) => {
        const result = await agent.agentState.toolTable.execute({
          id: "call",
          name: "whoami",
          input: {},
        });
        expect(result.isError).toBeUndefined();
        expect(result.content).toBe("sek-ret-9000");
      },
    );
  });

  it("fails boot when a declared secret is absent from the store", async () => {
    delete process.env.MOCK_API_KEY;
    await expect(
      runAgent(envServerSpec("mcp-secret-missing-e2e"), {}),
    ).rejects.toThrow(/MOCK_API_KEY/);
  });

  it("spawns one MCP server per [providers] handle regardless of instance count", async () => {
    const spec = echoServerSpec(
      "mcp-single-server",
      {
        echo: { provider: "echo_mcp" },
        say: { provider: "echo_mcp", tool: "echo" },
        shout: { provider: "echo_mcp", tool: "echo" },
        add: { provider: "echo_mcp" },
        add_to_10: { provider: "echo_mcp", tool: "add" },
        whisper: { provider: "echo_mcp", tool: "echo" },
      },
      {
        echo: "*",
        say: "*",
        shout: "*",
        add: "*",
        add_to_10: { a: 10, b: "*" },
        whisper: "*",
      },
    );
    await withAgent(spec, {}, async (agent) => {
      const names = agent.agentState.toolTable
        .list()
        .map((t) => t.name)
        .sort();
      expect(names).toEqual([
        "add",
        "add_to_10",
        "echo",
        "say",
        "shout",
        "whisper",
      ]);

      const { auditAgent } = await import("../src/audit/audit.js");
      const tree = await auditAgent(spec);
      const mcpProviders = tree.providers.filter(
        (p) => p.factoryName === "mcp-server",
      );
      expect(mcpProviders).toHaveLength(1);

      const a = await agent.agentState.toolTable.execute({
        id: "a",
        name: "say",
        input: { text: "hi" },
      });
      expect(a.content).toBe("hi");
      const b = await agent.agentState.toolTable.execute({
        id: "b",
        name: "add_to_10",
        input: { b: 5 },
      });
      expect(b.content).toBe("15");
    });
  });

  it("hides server tools that are not named in [tools]", async () => {
    const spec = echoServerSpec(
      "mcp-static-enum-e2e",
      { echo: { provider: "echo_mcp" } },
      { echo: "*" },
    );
    await withAgent(spec, {}, async (agent) => {
      const names = agent.agentState.toolTable.list().map((t) => t.name);
      expect(names).toEqual(["echo"]);
      expect(names).not.toContain("add");
    });
  });
});
