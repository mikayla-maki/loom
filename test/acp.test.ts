import { beforeAll, describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { Readable, Writable } from "node:stream";

import { serveOverStream } from "../src/acp/server.js";
import { ACP_PROTOCOL_VERSION } from "../src/acp/server.js";
import { runAgent } from "../src/sdk/run-agent.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import {
  ClientSideConnection,
  ndJsonStream,
  type Agent,
  type Client,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AgentManifest } from "../src/types/manifest.js";

const FIXTURES = path.resolve("test/fixtures");

/**
 * Build a pair of WHATWG streams whose readable/writable halves are
 * cross-wired so a server connection on one side talks to a client
 * connection on the other. No subprocess; tests the protocol shape.
 */
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

    // Build a minimal Client implementation that records the updates
    // arriving from the agent.
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

    // Give the forwarder a chance to flush any in-flight updates.
    await new Promise((r) => setTimeout(r, 20));

    // Confirm we saw the agent's emitted updates over the wire.
    expect(updates).toContain("user_message_chunk");
    expect(updates).toContain("agent_message_chunk");

    // Tear down: close streams from both ends so the SDK Connection
    // loops exit cleanly.
    await closeAll();
    await clientStream.writable.close().catch(() => undefined);
    await serverStream.writable.close().catch(() => undefined);
    void serverConn;
    await agent.close();
  });
});

/** Spawn `loom acp serve` and return an SDK-level Agent client. */
async function spawnLoomAcp(args: {
  cliEntry: string;
  manifestPath: string;
  /** Working directory for the child process. */
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

  /** `it` variant that silently skips when the CLI bundle is missing. */
  const sit = (name: string, fn: () => Promise<void>): void => {
    it(name, async () => {
      if (!CLI_AVAILABLE) return;
      await fn();
    });
  };

  sit("drives the sample agent end-to-end via stdio", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loom-acp-cli-"));
    try {
      const agentDir = path.join(tmp, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.cp(
        path.join(FIXTURES, "sample-agent", "identity.md"),
        path.join(agentDir, "identity.md"),
      );
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
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
      );

      const { client, shutdown } = await spawnLoomAcp({
        cliEntry: CLI_ENTRY,
        manifestPath: path.join(agentDir, "agent.toml"),
      });
      try {
        await client.initialize({
          protocolVersion: ACP_PROTOCOL_VERSION,
        });
        const ns = await client.newSession({
          cwd: agentDir,
          mcpServers: [],
        });
        const result = await client.prompt({
          sessionId: ns.sessionId,
          prompt: [{ type: "text", text: "hello acp" }],
        });
        expect(result.stopReason).toBe("end_turn");
      } finally {
        shutdown();
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  sit("honors the client's `cwd` for tool path resolution", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loom-acp-cwd-"));
    try {
      // Two distinct directories: the agent definition lives in one,
      // the workspace the client is asking about lives in another.
      // Spawning loom from yet another dir (os.tmpdir() itself)
      // guarantees that `process.cwd()` at boot has no relationship
      // to either, so a passing test proves the chdir actually
      // happened.
      const agentDir = path.join(tmp, "agent");
      const workspaceDir = path.join(tmp, "workspace");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "hello.txt"), "world\n");

      // Test harness with a scripted read_file call. The grant
      // `paths = ["./"]` is resolved against `process.cwd()` at boot,
      // which (if chdir works) is `workspaceDir`. read_file is then
      // invoked with a relative path that should resolve there.
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
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
      );

      const { client, collected, shutdown } = await spawnLoomAcp({
        cliEntry: CLI_ENTRY,
        manifestPath: path.join(agentDir, "agent.toml"),
        spawnCwd: os.tmpdir(),
      });
      try {
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

        // The agent_message_chunks emitted by the scripted harness
        // should contain the contents of `hello.txt` if cwd was
        // honored.
        const text = collected
          .map((n) => n.update)
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) =>
            "content" in u && u.content.type === "text" ? u.content.text : "",
          )
          .join("");
        expect(text).toContain("world");
      } finally {
        shutdown();
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  sit("rejects `session/new` with a relative `cwd`", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loom-acp-cwd-rel-"));
    try {
      const agentDir = path.join(tmp, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "rel-cwd"
system_prompt = "x"
secrets = []
[tools]
[harness]
provider = "test"
echo = true
`,
      );
      const { client, shutdown } = await spawnLoomAcp({
        cliEntry: CLI_ENTRY,
        manifestPath: path.join(agentDir, "agent.toml"),
      });
      try {
        await client.initialize({ protocolVersion: ACP_PROTOCOL_VERSION });
        await expect(
          client.newSession({ cwd: "./relative", mcpServers: [] }),
        ).rejects.toThrow(/absolute/);
      } finally {
        shutdown();
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  sit("rejects `session/new` with non-empty `mcpServers`", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loom-acp-mcp-"));
    try {
      const agentDir = path.join(tmp, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "no-mcp"
system_prompt = "x"
secrets = []
[tools]
[harness]
provider = "test"
echo = true
`,
      );
      const { client, shutdown } = await spawnLoomAcp({
        cliEntry: CLI_ENTRY,
        manifestPath: path.join(agentDir, "agent.toml"),
      });
      try {
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
      } finally {
        shutdown();
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
