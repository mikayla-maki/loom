import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { LoomServer } from "../src/server/server.js";
import { connectUnix } from "../src/acp/client.js";

describe("LoomServer.embed() — broker socket", () => {
  it("validates token + scope, dispatches to the registered manifest, and rejects unknown tokens", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-broker-"));
    const server = await LoomServer.embed();
    try {
      // A trivial child agent the broker will dispatch to. The broker
      // resolves subagents by manifest path, so this one stays on disk.
      const childDir = path.join(root, "child");
      await fs.mkdir(childDir, { recursive: true });
      await fs.writeFile(
        path.join(childDir, "agent.toml"),
        `[agent]
name = "child"
system_prompt = "c"
[tools]

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
      const childManifest = path.join(childDir, "agent.toml");

      // Mint a token bound to one skill with one allowed subagent.
      const token = server.mintToken("greeter-skill", {
        helper: childManifest,
      });
      expect(server.tokenCount).toBe(1);

      // Connect via Unix socket the way `loom-invoke` will.
      const c = await connectUnix(server.socketPath);
      try {
        // Valid invocation.
        const res = await c.prompt({
          prompt: "hi from broker",
          token,
          scope: "helper",
        });
        expect(res.stopReason).toBe("end_turn");
        expect(res.finalMessage).toContain("echo: hi from broker");

        // Unknown scope on a valid token → -32001 invalid token or scope.
        await expect(
          c.prompt({ prompt: "x", token, scope: "not-allowed" }),
        ).rejects.toThrow(/invalid token or scope/);

        // Unknown token → same error.
        await expect(
          c.prompt({ prompt: "x", token: "tok_garbage", scope: "helper" }),
        ).rejects.toThrow(/invalid token or scope/);
      } finally {
        await c.close();
      }

      // Revocation removes the token.
      server.revokeToken(token);
      expect(server.tokenCount).toBe(0);
    } finally {
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non-broker methods with -32601", async () => {
    const server = await LoomServer.embed();
    try {
      const c = await connectUnix(server.socketPath);
      try {
        // session/new is no longer supported on the embed server.
        await expect(c.newSession()).rejects.toThrow(
          /Method not supported on embed broker/,
        );
      } finally {
        await c.close();
      }
    } finally {
      await server.close();
    }
  });

  it("close() unlinks the socket file", async () => {
    const server = await LoomServer.embed();
    const sock = server.socketPath;
    await server.close();
    let stillThere = true;
    try {
      await fs.access(sock);
    } catch {
      stillThere = false;
    }
    expect(stillThere).toBe(false);
  });
});
