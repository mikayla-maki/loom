import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { PassThrough } from "node:stream";

import { ndjsonStream } from "../src/acp/framing.js";
import { AcpRouter, routerOverStreams } from "../src/acp/server.js";
import { runAgent } from "../src/sdk/run-agent.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import type { AgentManifest } from "../src/types/manifest.js";

const FIXTURES = path.resolve("test/fixtures");

/**
 * In-process ACP round-trip — a router on one pair of streams, a JSON-RPC
 * client on the inverted pair. No subprocess; tests the protocol shape.
 */
function makePipes(): {
  serverIn: PassThrough;
  serverOut: PassThrough;
  clientIn: PassThrough;
  clientOut: PassThrough;
} {
  const serverIn = new PassThrough();
  const serverOut = new PassThrough();
  return {
    serverIn,
    serverOut,
    clientIn: serverOut,
    clientOut: serverIn,
  };
}

describe("ACP round-trip (in-process streams)", () => {
  it("session/new + session/prompt + session/update notifications", async () => {
    const { serverIn, serverOut, clientIn, clientOut } = makePipes();

    // Build a pre-booted agent the router will hand out. Inline spec —
    // this test cares about the ACP protocol shape, not disk layout.
    const spec: AgentManifest = {
      name: "acp-inline",
      systemPrompt: "You are an ACP test agent.",
      tools: {},
      harness: {
        provider: "test",
        script: [[{ say: "hi from agent" }, { stop: "end_turn" }]],
      },
      sandbox: { filesystem: [], network: [], secrets: ["sample_user_name"] },
    };
    const agent = await runAgent(spec, {
      secrets: new StaticSecretsStore({ sample_user_name: "ACP" }),
    });

    const router = new AcpRouter({
      agentFactory: async () => agent,
      // Inline specs have no on-disk manifestPath; the router still
      // requires *something* to satisfy session/new, but the agentFactory
      // ignores it (always returns the pre-booted agent above).
      fixedManifestPath: agent.resolved.source.manifestPath ?? "<inline>",
    });
    const routerDone = routerOverStreams(router, serverIn, serverOut);

    // Client-side: drive JSON-RPC manually.
    const clientStream = ndjsonStream(clientIn, clientOut);
    const sent: unknown[] = [];
    clientStream.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: {},
      }),
    );
    let ns: { sessionId?: string } = {};
    let updates: string[] = [];
    let promptResult: { stopReason?: string; finalMessage?: string } | null =
      null;

    const consumer = (async () => {
      for await (const m of clientStream.messages()) {
        sent.push(m);
        const msg = m as {
          id?: number;
          result?: unknown;
          method?: string;
          params?: { update?: { sessionUpdate?: string } };
        };
        if (msg.id === 1) {
          ns = msg.result as { sessionId: string };
          // session/prompt next
          clientStream.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "session/prompt",
              params: { sessionId: ns.sessionId, prompt: "hello" },
            }),
          );
        } else if (msg.id === 2) {
          promptResult = msg.result as {
            stopReason: string;
            finalMessage: string;
          };
          // close server-side
          clientStream.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              method: "session/close",
              params: { sessionId: ns.sessionId },
            }),
          );
        } else if (msg.id === 3) {
          serverIn.end();
          clientStream.close();
          break;
        } else if (msg.method === "session/update") {
          updates.push(msg.params!.update!.sessionUpdate!);
        }
      }
    })();

    await Promise.all([routerDone, consumer]);
    expect(ns.sessionId).toMatch(/^s\d+$/);
    expect(promptResult).not.toBeNull();
    expect(promptResult!.stopReason).toBe("end_turn");
    expect(promptResult!.finalMessage).toContain("hi from agent");
    expect(updates).toContain("user_message_chunk");
    expect(updates).toContain("agent_message_chunk");
    expect(updates).toContain("stop");
  });
});

describe("ACP over spawned `loom acp serve` (subprocess, real stdio)", () => {
  it("drives the sample agent end-to-end via stdio", async () => {
    // This test spawns the compiled CLI as a child process. If `dist/`
    // hasn't been built yet (fresh checkout, `npm test` before `npm run
    // build`) the spawn would hang for the test-timeout window. Skip
    // explicitly with a clear message instead.
    const cliEntry = path.resolve("dist/cli/main.js");
    try {
      await fs.access(cliEntry);
    } catch {
      console.warn(
        `[acp.test] skipping subprocess test: ${cliEntry} not found. Run \`npm run build\` first.`,
      );
      return;
    }

    const { spawn } = await import("node:child_process");
    const { connectStdio } = await import("../src/acp/client.js");

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loom-acp-cli-"));
    try {
      // Materialize a self-contained sample agent so secrets resolve via .loom-secrets.
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
[tools]

[harness]
provider = "test"
echo = true
[session]
provider = "file"
path = "./session.jsonl"
[sandbox]
filesystem = ["./"]
network = []
secrets = []
[skills]
`,
      );

      const child = spawn(
        process.execPath,
        [cliEntry, "acp", "serve", path.join(agentDir, "agent.toml")],
        { stdio: ["pipe", "pipe", "inherit"] },
      );
      const client = connectStdio(child);
      try {
        // Pre-booted agent in stdio mode is bound to session id "s1" — but the
        // server's serveOverStdio doesn't expose session/new. We use the
        // primary session implicitly by passing only the prompt.
        const result = await client.prompt({
          prompt: "hello acp",
          sessionId: "s1",
        });
        expect(result.stopReason).toBe("end_turn");
        expect(result.finalMessage).toContain("echo: hello acp");
      } finally {
        await client.close();
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
