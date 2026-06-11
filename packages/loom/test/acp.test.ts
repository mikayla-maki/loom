import { beforeAll, describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { Readable, Writable } from "node:stream";

import { serveOverStream } from "../src/acp/server.js";
import { ACP_PROTOCOL_VERSION } from "../src/acp/server.js";
import { runAgent } from "../src/sdk/run-agent.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import { withTmpDir } from "./helpers/tmp.js";
import {
  ClientSideConnection,
  ndJsonStream,
  type Agent,
  type Client,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AgentManifest } from "../src/types/manifest.js";

const FIXTURES = path.resolve("test/fixtures");

function makeInProcessPipe(): {
  serverStream: import("@agentclientprotocol/sdk").Stream;
  clientStream: import("@agentclientprotocol/sdk").Stream;
} {
  const c2s = new TransformStream<unknown, unknown>();
  const s2c = new TransformStream<unknown, unknown>();
  return {
    serverStream: { readable: c2s.readable, writable: s2c.writable },
    clientStream: { readable: s2c.readable, writable: c2s.writable },
  } as never;
}

describe("ACP round-trip (in-process streams)", () => {
  it("initialize + session/new + session/prompt + updates", async () => {
    const spec: AgentManifest = {
      name: "acp-inline",
      systemPrompt: "You are an ACP test agent.",
      tools: {},
      harness: {
        provider: "test",
        script: [[{ say: "hi from agent" }, { stop: "end_turn" }]],
      },
      capabilities: {},
    };
    const agent = await runAgent(spec, {
      secrets: new StaticSecretsStore({ sample_user_name: "ACP" }),
    });

    const { serverStream, clientStream } = makeInProcessPipe();

    const { connection: serverConn, closeAll } = serveOverStream(
      async () => agent,
      serverStream,
    );

    const updates: string[] = [];
    const clientImpl: Client = {
      async sessionUpdate(n: SessionNotification) {
        updates.push(n.update.sessionUpdate);
      },
      async requestPermission() {
        return { outcome: { outcome: "cancelled" as const } };
      },
    };
    const clientConn: Agent = new ClientSideConnection(
      () => clientImpl,
      clientStream,
    );

    const initResp = await clientConn.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true } },
    });
    expect(initResp.protocolVersion).toBe(ACP_PROTOCOL_VERSION);

    const ns = await clientConn.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    expect(ns.sessionId).toMatch(/^s\d+$/);

    const result = await clientConn.prompt({
      sessionId: ns.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    expect(result.stopReason).toBe("end_turn");

    await new Promise((r) => setTimeout(r, 20));

    expect(updates).toContain("user_message_chunk");
    expect(updates).toContain("agent_message_chunk");

    await closeAll();
    await clientStream.writable.close().catch(() => undefined);
    await serverStream.writable.close().catch(() => undefined);
    void serverConn;
    await agent.close();
  });
});

async function spawnLoomAcp(args: {
  cliEntry: string;
  manifestPath: string;
  spawnCwd?: string;
}): Promise<{
  client: Agent;
  collected: SessionNotification[];
  shutdown(): void;
}> {
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    [args.cliEntry, "acp", "serve", args.manifestPath],
    {
      stdio: ["pipe", "pipe", "inherit"],
      ...(args.spawnCwd ? { cwd: args.spawnCwd } : {}),
    },
  );
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );
  const collected: SessionNotification[] = [];
  const clientImpl: Client = {
    async sessionUpdate(n) {
      collected.push(n);
    },
    async requestPermission() {
      return { outcome: { outcome: "cancelled" as const } };
    },
  };
  const client: Agent = new ClientSideConnection(() => clientImpl, stream);
  return {
    client,
    collected,
    shutdown() {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

const CLI_ENTRY = path.resolve("dist/cli/main.js");
let CLI_AVAILABLE = false;

describe("ACP over spawned `loom acp serve` (subprocess, real stdio)", () => {
  beforeAll(async () => {
    try {
      await fs.access(CLI_ENTRY);
      CLI_AVAILABLE = true;
    } catch {
      console.warn(
        `[acp.test] skipping subprocess tests: ${CLI_ENTRY} not found. Run \`npm run build\` first.`,
      );
    }
  });

  const sit = (name: string, fn: () => Promise<void>): void => {
    it(name, async () => {
      if (!CLI_AVAILABLE) return;
      await fn();
    });
  };

  async function withSpawnedAgent(
    args: {
      prefix: string;
      manifest: string;
      spawnCwd?: string;
      // Runs after the agent dir exists but before spawn (e.g. copy fixtures).
      prepare?: (agentDir: string) => Promise<void>;
    },
    run: (ctx: {
      agentDir: string;
      tmp: string;
      client: Agent;
      collected: SessionNotification[];
    }) => Promise<void>,
  ): Promise<void> {
    await withTmpDir(args.prefix, async (tmp) => {
      const agentDir = path.join(tmp, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await args.prepare?.(agentDir);
      await fs.writeFile(path.join(agentDir, "agent.toml"), args.manifest);
      const { client, collected, shutdown } = await spawnLoomAcp({
        cliEntry: CLI_ENTRY,
        manifestPath: path.join(agentDir, "agent.toml"),
        spawnCwd: args.spawnCwd,
      });
      try {
        await run({ agentDir, tmp, client, collected });
      } finally {
        shutdown();
      }
    });
  }

  sit("drives the sample agent end-to-end via stdio", async () => {
    await withSpawnedAgent(
      {
        prefix: "loom-acp-cli-",
        prepare: (agentDir) =>
          fs.cp(
            path.join(FIXTURES, "sample-agent", "identity.md"),
            path.join(agentDir, "identity.md"),
          ),
        manifest: `[agent]
name = "acp-sample"
system_prompt = "./identity.md"
secrets = []
[tools]

[harness]
provider = "test"
echo = true
[session]
provider = "file"
path = "./session.jsonl"
`,
      },
      async ({ agentDir, client }) => {
        await client.initialize({ protocolVersion: ACP_PROTOCOL_VERSION });
        const ns = await client.newSession({ cwd: agentDir, mcpServers: [] });
        const result = await client.prompt({
          sessionId: ns.sessionId,
          prompt: [{ type: "text", text: "hello acp" }],
        });
        expect(result.stopReason).toBe("end_turn");
      },
    );
  });

  sit("honors the client's `cwd` for tool path resolution", async () => {
    // Spawn from os.tmpdir() so boot-time process.cwd() relates to neither the
    // agent dir nor the workspace; passing proves chdir to the client cwd ran.
    await withSpawnedAgent(
      {
        prefix: "loom-acp-cwd-",
        spawnCwd: os.tmpdir(),
        manifest: `[agent]
name = "cwd-probe"
system_prompt = "You are a test agent."
secrets = []
[tools]
read_file = "builtin"
[capabilities.read_file]
paths = ["./"]
[harness]
provider = "test"
script = [ [ { call = { tool = "read_file", input = { path = "hello.txt" } }, surface = true }, { stop = "end_turn" } ] ]
`,
      },
      async ({ tmp, client, collected }) => {
        const workspaceDir = path.join(tmp, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "hello.txt"), "world\n");

        await client.initialize({ protocolVersion: ACP_PROTOCOL_VERSION });
        const ns = await client.newSession({
          cwd: workspaceDir,
          mcpServers: [],
        });
        const result = await client.prompt({
          sessionId: ns.sessionId,
          prompt: [{ type: "text", text: "go" }],
        });
        expect(result.stopReason).toBe("end_turn");

        const text = collected
          .map((n) => n.update)
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) =>
            "content" in u && u.content.type === "text" ? u.content.text : "",
          )
          .join("");
        expect(text).toContain("world");
      },
    );
  });

  const echoManifest = (name: string): string => `[agent]
name = "${name}"
system_prompt = "x"
secrets = []
[tools]
[harness]
provider = "test"
echo = true
`;

  sit("rejects `session/new` with a relative `cwd`", async () => {
    await withSpawnedAgent(
      { prefix: "loom-acp-cwd-rel-", manifest: echoManifest("rel-cwd") },
      async ({ client }) => {
        await client.initialize({ protocolVersion: ACP_PROTOCOL_VERSION });
        await expect(
          client.newSession({ cwd: "./relative", mcpServers: [] }),
        ).rejects.toThrow(/absolute/);
      },
    );
  });

  sit("rejects `session/new` with non-empty `mcpServers`", async () => {
    await withSpawnedAgent(
      { prefix: "loom-acp-mcp-", manifest: echoManifest("no-mcp") },
      async ({ agentDir, client }) => {
        await client.initialize({ protocolVersion: ACP_PROTOCOL_VERSION });
        await expect(
          client.newSession({
            cwd: agentDir,
            mcpServers: [
              {
                type: "stdio",
                name: "x",
                command: "/bin/true",
                args: [],
                env: [],
              } as never,
            ],
          }),
        ).rejects.toThrow(/MCP/i);
      },
    );
  });
});
