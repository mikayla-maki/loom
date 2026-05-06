import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { GlassDaemon } from "../src/daemon/server.ts";
import { connectUnix } from "../src/acp/client.js";

const FIXTURES = path.resolve("test/fixtures");

describe("GlassDaemon — Unix socket transport", () => {
  it("session/new + session/prompt over the daemon socket", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glass-daemon-"));
    const socketPath = path.join(dir, "glass.sock");
    const daemon = new GlassDaemon({ socketPath });
    await daemon.start();
    try {
      // Material: an agent that uses test harness in echo mode.
      const agentDir = path.join(dir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "daemon-agent"
identity_inline = "x"
[harness]
provider = "test"
echo = true
[session]
provider = "memory"
[sandbox]
filesystem = []
network = []
secrets = []
[skills]
`,
      );

      const client = await connectUnix(socketPath);
      try {
        const ns = await client.newSession(path.join(agentDir, "agent.toml"));
        expect(ns.agentName).toBe("daemon-agent");
        const r = await client.prompt({ sessionId: ns.sessionId, prompt: "ping" });
        expect(r.stopReason).toBe("end_turn");
        expect(r.finalMessage).toContain("echo: ping");
        await client.closeSession(ns.sessionId);
      } finally {
        await client.close();
      }

      // Bonus: the same client doesn't see the fixtures path so we used a
      // freshly-built one. Just confirm the daemon also serves the bundled
      // sample agent.
      const c2 = await connectUnix(socketPath);
      try {
        // Skip if no .glass-secrets — for the sample agent we'd need it.
        // Build a dedicated copy with no secrets.
        const a2 = path.join(dir, "agent2");
        await fs.mkdir(a2, { recursive: true });
        await fs.writeFile(
          path.join(a2, "agent.toml"),
          `[agent]
name = "second"
identity_inline = "y"
[harness]
provider = "test"
[session]
provider = "memory"
[sandbox]
filesystem = []
network = []
secrets = []
[skills]
`,
        );
        const ns2 = await c2.newSession(path.join(a2, "agent.toml"));
        const r2 = await c2.prompt({ sessionId: ns2.sessionId, prompt: "anything" });
        expect(r2.stopReason).toBe("end_turn");
      } finally {
        await c2.close();
      }
      void FIXTURES;
    } finally {
      await daemon.stop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("token-broker: validates token + scope, rejects unknown", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glass-broker-"));
    const socketPath = path.join(dir, "glass.sock");
    const daemon = new GlassDaemon({ socketPath });
    await daemon.start();
    try {
      // Set up a child agent.
      const childDir = path.join(dir, "child");
      await fs.mkdir(childDir, { recursive: true });
      await fs.writeFile(
        path.join(childDir, "agent.toml"),
        `[agent]
name = "child"
identity_inline = "c"
[harness]
provider = "test"
echo = true
[session]
provider = "memory"
[sandbox]
filesystem = []
network = []
secrets = []
[skills]
`,
      );

      const token = daemon.mintToken("agentA", "skillX", {
        helper: path.join(childDir, "agent.toml"),
      });

      // Connect and call session/prompt with token + scope (broker shape).
      const { connect } = await import("node:net");
      const sock = connect(socketPath);
      await new Promise<void>((res) => sock.once("connect", () => res()));

      const send = (msg: unknown) => {
        sock.write(JSON.stringify(msg) + "\n");
      };

      const wait = (id: number) =>
        new Promise<{ result?: unknown; error?: { code: number; message: string } }>((resolve) => {
          let buf = "";
          sock.on("data", (b) => {
            buf += b.toString("utf8");
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              try {
                const m = JSON.parse(line);
                if (m.id === id) resolve(m);
              } catch {
                // ignore
              }
            }
          });
        });

      // Valid scope.
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "session/prompt",
        params: { token, scope: "helper", prompt: "hi child" },
      });
      const ok = await wait(1);
      expect(ok.result).toBeDefined();
      expect((ok.result as { finalMessage: string }).finalMessage).toContain("echo: hi child");

      // Invalid scope.
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { token, scope: "evil", prompt: "x" },
      });
      const bad = await wait(2);
      expect(bad.error).toBeDefined();
      expect(bad.error!.message).toMatch(/invalid token or scope/);

      // Invalid token.
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: { token: "tok_fake", scope: "helper", prompt: "x" },
      });
      const bad2 = await wait(3);
      expect(bad2.error).toBeDefined();

      sock.end();
    } finally {
      await daemon.stop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
