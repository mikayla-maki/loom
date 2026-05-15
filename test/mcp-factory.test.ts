/**
 * MCP `mcp-server` factory tests.
 *
 * Chunk 2 (lifecycle): proves the factory spawns a real stdio MCP
 * server, completes the initialize handshake, captures server info,
 * and reaps the child on close().
 *
 * Chunk 3 (tool resolution + execution) and beyond extend this file
 * as those chunks land.
 */

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

/** Returns true when a process with `pid` is still alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM means the process exists but we can't signal it; still alive.
    if ((e as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
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

  it("constructs successfully with command + args", () => {
    // create() doesn't actually spawn — it just wires up the
    // transport. The spawn happens at init().
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
    const tools = mcpServerToolsFactory.create(
      { command: process.execPath, args: [ECHO_SERVER] },
      ctx(),
      {},
      undefined,
    ) as McpServerTools;

    await tools.init(
      initArgs({ command: process.execPath, args: [ECHO_SERVER] }),
    );

    // The initialize handshake populated the serverInfo cache.
    const info = defined(tools.serverInfo, "serverInfo not populated");
    expect(info.name).toBe("loom-test-mcp-echo");
    expect(info.version).toBe("0.0.1");
    expect(info.capabilities).toMatchObject({ tools: {} });

    // Resolve the child PID through the transport's internals (the
    // factory does the same trick to enforce graceful shutdown).
    const proc = (tools.transport as unknown as { _process?: { pid?: number } })
      ._process;
    const pid = defined(
      defined(proc, "transport._process missing").pid,
      "process pid missing",
    );
    expect(typeof pid).toBe("number");
    expect(isAlive(pid)).toBe(true);

    // resolveTool returns null for unknown names. (Discovery +
    // execute behaviour gets its own dedicated suite below.)
    expect(
      tools.resolveTool("not_a_real_tool", {}, {} as never, undefined),
    ).toBeNull();

    await tools.close();

    // Poll briefly — the SDK closes the transport synchronously but
    // OS process reaping is asynchronous.
    let alive = isAlive(pid);
    for (let i = 0; i < 20 && alive; i++) {
      await wait(50);
      alive = isAlive(pid);
    }
    expect(alive).toBe(false);

    // close() is idempotent: subsequent calls resolve cleanly.
    await tools.close();
    await tools.close();
  });

  it("close() before init() is a no-op", async () => {
    const tools = mcpServerToolsFactory.create(
      { command: process.execPath, args: [ECHO_SERVER] },
      ctx(),
      {},
      undefined,
    ) as McpServerTools;
    await tools.close();
  });
});

describe("mcp-server factory — tool resolution + execution (Chunk 3)", () => {
  it("caches the server's tool list on init() and resolves discovered tools", async () => {
    const tools = mcpServerToolsFactory.create(
      { command: process.execPath, args: [ECHO_SERVER] },
      ctx(),
      {},
      undefined,
    ) as McpServerTools;
    try {
      await tools.init(
        initArgs({ command: process.execPath, args: [ECHO_SERVER] }),
      );
      // The cache reflects exactly what `tools/list` returned.
      expect([...tools.toolsCache.keys()].sort()).toEqual(["add", "echo"]);
      const t = defined(
        tools.resolveTool("echo", {}, {} as never, undefined),
        "resolveTool('echo') returned null",
      );
      expect(t.name).toBe("echo");
      expect(t.description).toMatch(/Return the input verbatim/);
      // The MCP-side schema flows through verbatim (Chunk 5 will
      // narrow it; for now we mirror it).
      expect((t.inputSchema as { properties?: unknown }).properties).toEqual({
        text: expect.objectContaining({ type: "string" }),
      });
    } finally {
      await tools.close();
    }
  });

  // (`resolveTool` returning null for unknown names is covered by
  // the lifecycle suite above; no need to duplicate the spawn here.)

  it("execute() runs the MCP tool and surfaces text content as a Loom ToolResult", async () => {
    const tools = mcpServerToolsFactory.create(
      { command: process.execPath, args: [ECHO_SERVER] },
      ctx(),
      {},
      undefined,
    ) as McpServerTools;
    try {
      await tools.init(
        initArgs({ command: process.execPath, args: [ECHO_SERVER] }),
      );
      const echo = defined(
        tools.resolveTool("echo", {}, {} as never, undefined),
        "resolveTool('echo') returned null",
      );
      const result = await echo.execute({ text: "hello loom" }, {} as never);
      expect(result.isError).toBeUndefined();
      expect(result.content).toBe("hello loom");
    } finally {
      await tools.close();
    }
  });

  it("supports the `tool` rename so one MCP tool can be exposed under multiple model-facing names", async () => {
    const tools = mcpServerToolsFactory.create(
      { command: process.execPath, args: [ECHO_SERVER] },
      ctx(),
      {},
      undefined,
    ) as McpServerTools;
    try {
      await tools.init(
        initArgs({ command: process.execPath, args: [ECHO_SERVER] }),
      );
      // `say` is the model-facing name; the underlying MCP tool is
      // still `echo`.
      const say = defined(
        tools.resolveTool("say", { tool: "echo" }, {} as never, undefined),
        "resolveTool('say') returned null",
      );
      expect(say.name).toBe("say");
      const result = await say.execute({ text: "renamed!" }, {} as never);
      expect(result.content).toBe("renamed!");
    } finally {
      await tools.close();
    }
  });

  it("runs end-to-end through runAgent: configured-factory [providers] → [tools] → executable Tool", async () => {
    // Full manifest → runtime path. Boots an agent whose [providers]
    // points the configured-factory `mcp-server` form at our fixture,
    // exposes one tool, and verifies the ToolTable actually executes
    // against the live MCP server.
    const spec: AgentManifest = {
      name: "mcp-e2e",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: {
        echo_mcp: {
          provider: "mcp-server",
          command: process.execPath,
          args: [ECHO_SERVER],
        },
      },
      tools: {
        echo: { provider: "echo_mcp" },
      },
      capabilities: {
        echo: "*",
      },
    };
    const agent = await runAgent(spec, {});
    try {
      const names = agent.agentState.toolTable.list().map((t) => t.name);
      expect(names).toEqual(["echo"]);
      const result = await agent.agentState.toolTable.execute({
        id: "call-1",
        name: "echo",
        input: { text: "hello from runAgent" },
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toBe("hello from runAgent");
    } finally {
      await agent.close();
    }
  });

  it("end-to-end: same MCP tool exposed under multiple model-facing names via the `tool` rename", async () => {
    const spec: AgentManifest = {
      name: "mcp-rename-e2e",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: {
        echo_mcp: {
          provider: "mcp-server",
          command: process.execPath,
          args: [ECHO_SERVER],
        },
      },
      tools: {
        echo: { provider: "echo_mcp" },
        say: { provider: "echo_mcp", tool: "echo" },
        shout: { provider: "echo_mcp", tool: "echo" },
      },
      capabilities: {
        echo: "*",
        say: "*",
        shout: "*",
      },
    };
    const agent = await runAgent(spec, {});
    try {
      const names = agent.agentState.toolTable
        .list()
        .map((t) => t.name)
        .sort();
      expect(names).toEqual(["echo", "say", "shout"]);
      // Each alias dispatches to the same underlying MCP tool.
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
    } finally {
      await agent.close();
    }
  });

  it("appends a host note to the description when args are pre-bound, listing the bound names", async () => {
    // The MCP tool's original description references the bound arg.
    // Without the host note, the model would see a description
    // saying "a + b" but a schema with only `b` — the note fixes
    // that mismatch and tells the model explicitly not to include
    // the bound args.
    const tools = mcpServerToolsFactory.create(
      { command: process.execPath, args: [ECHO_SERVER] },
      ctx(),
      {},
      undefined,
    ) as McpServerTools;
    try {
      await tools.init(
        initArgs({ command: process.execPath, args: [ECHO_SERVER] }),
      );
      // No grant → no annotation; the original description flows through.
      const plain = defined(
        tools.resolveTool("add", {}, {} as never, undefined),
        "resolveTool('add', no grant) returned null",
      );
      expect(plain.description).toBe("Add two integers.");
      expect(plain.description).not.toContain("Host note");

      // Literal binding on `a` → annotation surfaces.
      const bound = defined(
        tools.resolveTool("add", {}, {} as never, {
          a: 10,
          b: "*",
        }),
        "resolveTool('add', bound a) returned null",
      );
      expect(bound.description).toContain("Add two integers.");
      expect(bound.description).toContain("Host note");
      expect(bound.description).toContain("`a`");
      expect(bound.description).toContain("pre-configured");
      // Bound VALUES never appear in the description — secrets-safe.
      expect(bound.description).not.toContain("10");

      // Multiple bound args → list both, use plural phrasing.
      const bound2 = defined(
        tools.resolveTool("add", {}, {} as never, {
          a: 10,
          b: 20,
        }),
        "resolveTool('add', bound a+b) returned null",
      );
      expect(bound2.description).toContain("`a`");
      expect(bound2.description).toContain("`b`");
      expect(bound2.description).toMatch(/arguments are/);

      // Whole-tool `"*"` grant → no narrowing, no annotation.
      const starred = defined(
        tools.resolveTool("add", {}, {} as never, "*"),
        "resolveTool('add', '*' grant) returned null",
      );
      expect(starred.description).not.toContain("Host note");
    } finally {
      await tools.close();
    }
  });

  it("end-to-end: capability-based partial application binds an arg the model never sees", async () => {
    // The fixture's `add(a, b)` tool takes two numbers. Pre-bind
    // `a = 10` via [capabilities]; the model only chooses `b`. The
    // resulting Tool's inputSchema should advertise just `b`.
    const spec: AgentManifest = {
      name: "mcp-bind-e2e",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: {
        echo_mcp: {
          provider: "mcp-server",
          command: process.execPath,
          args: [ECHO_SERVER],
        },
      },
      tools: {
        // model-facing name `add_to_10`; underlying tool is still `add`.
        add_to_10: { provider: "echo_mcp", tool: "add" },
      },
      capabilities: {
        add_to_10: { a: 10, b: "*" },
      },
    };
    const agent = await runAgent(spec, {});
    try {
      const list = agent.agentState.toolTable.list();
      expect(list).toHaveLength(1);
      const t = defined(list[0], "toolTable.list() returned empty");
      // The narrowed schema hides `a` from the model.
      const props = (t.inputSchema as { properties: Record<string, unknown> })
        .properties;
      expect(Object.keys(props)).toEqual(["b"]);
      expect((t.inputSchema as { required: string[] }).required).toEqual(["b"]);
      // Execute with the model-supplied `b`; the bound `a = 10`
      // gets merged transparently.
      const result = await agent.agentState.toolTable.execute({
        id: "call",
        name: "add_to_10",
        input: { b: 7 },
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toBe("17");
    } finally {
      await agent.close();
    }
  });

  it("end-to-end: model attempting to override a bound arg is rejected with isError", async () => {
    const spec: AgentManifest = {
      name: "mcp-bind-override-e2e",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: {
        echo_mcp: {
          provider: "mcp-server",
          command: process.execPath,
          args: [ECHO_SERVER],
        },
      },
      tools: {
        bound_echo: { provider: "echo_mcp", tool: "echo" },
      },
      capabilities: {
        bound_echo: { text: "locked-value" },
      },
    };
    const agent = await runAgent(spec, {});
    try {
      // The narrowed schema has no `text` property, so Ajv rejects
      // before we even reach execute(). That's expected and is one
      // valid layer of defence; we just check the failure surfaces
      // as isError rather than throwing.
      const result = await agent.agentState.toolTable.execute({
        id: "call",
        name: "bound_echo",
        input: { text: "attempted override" },
      });
      expect(result.isError).toBe(true);
    } finally {
      await agent.close();
    }
  });

  it("end-to-end: secrets in MCP env (Chunk 6) — Loom secret injected as child env var", async () => {
    // The env-server fixture's `whoami` tool reports the value of
    // MOCK_API_KEY from its process env. The manifest declares
    // `secrets = { MOCK_API_KEY = "MOCK_API_KEY" }` which:
    //   1. Adds MOCK_API_KEY to the runtime's Phase-1 secret needs.
    //   2. Filters it into the create() secrets arg.
    //   3. The factory writes env[MOCK_API_KEY] = secrets[MOCK_API_KEY].
    // The test loads the secret from a StaticSecretsStore.
    const spec: AgentManifest = {
      name: "mcp-secret-e2e",
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
    const agent = await runAgent(spec, {
      secrets: new StaticSecretsStore({ MOCK_API_KEY: "sek-ret-9000" }),
    });
    try {
      const result = await agent.agentState.toolTable.execute({
        id: "call",
        name: "whoami",
        input: {},
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toBe("sek-ret-9000");
    } finally {
      await agent.close();
    }
  });

  it("end-to-end: secret declared but not present in the store fails boot", async () => {
    const spec: AgentManifest = {
      name: "mcp-secret-missing-e2e",
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
    // No StaticSecretsStore, no MOCK_API_KEY in env — boot should
    // fail at the loadSecretsBundle phase before the factory runs.
    delete process.env.MOCK_API_KEY;
    await expect(runAgent(spec, {})).rejects.toThrow(/MOCK_API_KEY/);
  });

  it("end-to-end: one [providers] handle = one MCP server process, regardless of per-tool config", async () => {
    // Seven [tools.X] entries, four distinct per-tool shapes, but
    // ALL pointing at the same [providers].echo_mcp handle. The
    // resolver must produce exactly ONE provider instance (= one
    // spawned MCP server); per-tool config is what flows to
    // resolveTool, never to Tools.create().
    const spec: AgentManifest = {
      name: "mcp-single-server",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: {
        echo_mcp: {
          provider: "mcp-server",
          command: process.execPath,
          args: [ECHO_SERVER],
        },
      },
      tools: {
        echo: { provider: "echo_mcp" },
        say: { provider: "echo_mcp", tool: "echo" },
        shout: { provider: "echo_mcp", tool: "echo" },
        add: { provider: "echo_mcp" },
        add_to_10: { provider: "echo_mcp", tool: "add" },
        whisper: { provider: "echo_mcp", tool: "echo", note: "extra" },
      },
      capabilities: {
        echo: "*",
        say: "*",
        shout: "*",
        add: "*",
        add_to_10: { a: 10, b: "*" },
        whisper: "*",
      },
    };
    const agent = await runAgent(spec, {});
    try {
      // All six tool bindings resolve, dispatch correctly.
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

      // Every tool routes through the same Tools instance —
      // verified via the audit, which records one provider per
      // distinct ProviderInstance.
      const { auditAgent } = await import("../src/audit/audit.js");
      const tree = await auditAgent(spec);
      const mcpProviders = tree.providers.filter(
        (p) => p.factoryName === "mcp-server",
      );
      expect(mcpProviders).toHaveLength(1);

      // Spot-check a couple of dispatches to prove the routing is
      // sound under the shared instance.
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
    } finally {
      await agent.close();
    }
  });

  it("end-to-end: static enumeration — server tools NOT in [tools] are NOT reachable", async () => {
    // The fixture advertises `echo` and `add`. The manifest only
    // names `echo`. `add` must be invisible on the agent.
    const spec: AgentManifest = {
      name: "mcp-static-enum-e2e",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: {
        echo_mcp: {
          provider: "mcp-server",
          command: process.execPath,
          args: [ECHO_SERVER],
        },
      },
      tools: {
        echo: { provider: "echo_mcp" },
      },
      capabilities: { echo: "*" },
    };
    const agent = await runAgent(spec, {});
    try {
      const names = agent.agentState.toolTable.list().map((t) => t.name);
      expect(names).toEqual(["echo"]);
      expect(names).not.toContain("add");
    } finally {
      await agent.close();
    }
  });

  it("rejects a non-string `tool` config value", async () => {
    const tools = mcpServerToolsFactory.create(
      { command: process.execPath, args: [ECHO_SERVER] },
      ctx(),
      {},
      undefined,
    ) as McpServerTools;
    try {
      await tools.init(
        initArgs({ command: process.execPath, args: [ECHO_SERVER] }),
      );
      expect(() =>
        tools.resolveTool(
          "foo",
          { tool: 42 as unknown as string },
          {} as never,
          undefined,
        ),
      ).toThrow(/'tool'.*must be a non-empty string/);
    } finally {
      await tools.close();
    }
  });
});
