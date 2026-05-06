/**
 * LoomServer — in-process broker for spawned-tool subagent invocation.
 *
 * Phase D shape: embed-only. The server starts an ephemeral Unix socket
 * inside the parent's tmpdir, mints per-skill tokens for spawned tools,
 * and validates broker requests of the form
 *
 *   session/prompt { token, scope, prompt } → { stopReason, finalMessage }
 *
 * No daemon-resident agents, no listen({ socketPath }), no `loom serve`.
 * The server's lifetime is bounded by `runAgent()`'s lifetime; close()
 * unlinks the socket and revokes outstanding tokens.
 *
 * The on-the-wire protocol is the same JSON-RPC framing as ACP so that
 * a future `LoomServer.listen()` can speak ACP without a transport rewrite.
 */

import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { createServer, Server, Socket } from "node:net";
import { randomBytes } from "node:crypto";

import { runAgent } from "../sdk/run-agent.js";
import { connectAcpUrl } from "../acp/client.js";
import { ndjsonStream, type MessageStream } from "../acp/framing.js";
import {
  ACP_METHODS,
  type JSONRPCRequest,
  type JSONRPCResponse,
} from "../acp/messages.js";
import { lastAgentMessage } from "../runtime/extract-message.js";

export interface BrokerTokenRecord {
  /** Skill that owns the token; informational, used for diagnostics. */
  skill: string;
  /** Map of subagent name (the `scope` arg) → manifest path or acp:// URL. */
  registry: Record<string, string>;
}

export class LoomServer {
  public readonly socketPath: string;
  /**
   * Per-server temp bin directory containing the `loom-invoke` shell
   * wrapper. ProcessTool prepends this to spawned tools' PATH so a tool
   * can shell out to `loom-invoke <scope>` without knowing where the
   * actual JS shim lives.
   */
  public readonly binDir: string;
  private readonly tokens = new Map<string, BrokerTokenRecord>();
  private server: Server | null = null;

  private constructor(socketPath: string, binDir: string) {
    this.socketPath = socketPath;
    this.binDir = binDir;
  }

  /**
   * Start an embed-mode broker bound to an ephemeral socket. The socket
   * lives in tmpdir under a random name; only spawned tool subprocesses
   * find it via the `LOOM_INVOKE_SOCKET` env var.
   */
  static async embed(): Promise<LoomServer> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loom-broker-"));
    const socketPath = path.join(tmp, "broker.sock");
    const binDir = await provisionInvokeShim(tmp);
    const inst = new LoomServer(socketPath, binDir);
    await inst.start();
    return inst;
  }

  /**
   * Mint a one-shot-or-many token bound to the calling skill and the
   * subagents that skill is allowed to invoke. The token is opaque; the
   * tool subprocess gets it via `LOOM_INVOKE_TOKEN` and uses it as the
   * authentication for `session/prompt`.
   */
  mintToken(skill: string, registry: Record<string, string>): string {
    const token = "tok_" + randomBytes(16).toString("hex");
    this.tokens.set(token, { skill, registry });
    return token;
  }

  /** Revoke a single token (e.g. when the spawning tool subprocess exits). */
  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  /** Validate a broker invocation; return the manifest path / URL or null. */
  resolveInvocation(token: string, scope: string): string | null {
    const rec = this.tokens.get(token);
    if (!rec || !(scope in rec.registry)) return null;
    return rec.registry[scope] ?? null;
  }

  /** Number of outstanding tokens (test hook). */
  get tokenCount(): number {
    return this.tokens.size;
  }

  async close(): Promise<void> {
    this.tokens.clear();
    if (this.server) {
      await new Promise<void>((r) => this.server!.close(() => r()));
      this.server = null;
    }
    await unlinkIfExists(this.socketPath);
    // Best-effort: remove the temp parent directory we created. Only safe
    // at close() time — doing this in start() would wipe the directory we
    // just mkdir'd.
    try {
      await fs.rm(path.dirname(this.socketPath), {
        recursive: true,
        force: true,
      });
    } catch {
      /* ignore */
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private async start(): Promise<void> {
    await fs.mkdir(path.dirname(this.socketPath), { recursive: true });
    await unlinkIfExists(this.socketPath);
    this.server = createServer((sock) => this.handleConnection(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
  }

  private handleConnection(sock: Socket): void {
    void this.serve(ndjsonStream(sock, sock)).catch(() => undefined);
  }

  private async serve(stream: MessageStream): Promise<void> {
    const respond = (id: unknown, result: unknown) =>
      stream.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: id as JSONRPCResponse["id"],
          result,
        }),
      );
    const respondError = (id: unknown, code: number, message: string) =>
      stream.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: id as JSONRPCResponse["id"],
          error: { code, message },
        }),
      );

    const inflight = new Set<Promise<void>>();
    for await (const raw of stream.messages()) {
      if (typeof raw !== "object" || raw === null) continue;
      const msg = raw as JSONRPCRequest;
      const task = this.dispatch(msg, { respond, respondError });
      inflight.add(task);
      task.finally(() => inflight.delete(task));
    }
    await Promise.allSettled(inflight);
  }

  private async dispatch(
    msg: JSONRPCRequest,
    ctx: {
      respond: (id: unknown, result: unknown) => void;
      respondError: (id: unknown, code: number, message: string) => void;
    },
  ): Promise<void> {
    const id = msg.id ?? null;
    try {
      const params = (msg.params ?? {}) as Record<string, unknown>;

      // The only method this server handles: broker invocation.
      if (
        msg.method === ACP_METHODS.sessionPrompt &&
        typeof params.token === "string" &&
        typeof params.scope === "string"
      ) {
        const ref = this.resolveInvocation(params.token, params.scope);
        if (!ref) {
          ctx.respondError(id, -32001, "invalid token or scope");
          return;
        }
        const final = await runRefOnce(ref, String(params.prompt ?? ""));
        ctx.respond(id, { stopReason: "end_turn", finalMessage: final });
        return;
      }

      ctx.respondError(
        id,
        -32601,
        `Method not supported on embed broker: ${msg.method}`,
      );
    } catch (e) {
      ctx.respondError(id, -32000, (e as Error).message);
    }
  }
}

/** Resolve a subagent reference to its final message. Path or acp:// URL. */
async function runRefOnce(ref: string, prompt: string): Promise<string> {
  if (ref.startsWith("acp://") || ref.startsWith("acp+unix://")) {
    const c = await connectAcpUrl(ref);
    try {
      const ns = c.agentName
        ? await c.newSession(c.agentName, { byName: true })
        : await c.newSession();
      const r = await c.prompt({ sessionId: ns.sessionId, prompt });
      return r.finalMessage ?? "";
    } finally {
      await c.close();
    }
  }
  const sub = await runAgent(ref);
  try {
    await sub.prompt(prompt);
    return await lastAgentMessage(sub.session);
  } finally {
    await sub.close();
  }
}

async function unlinkIfExists(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    /* ignore */
  }
}

/**
 * Locate the compiled `loom-invoke.js` shim.
 *
 * The shim is *always* the compiled .js (spawned tools shell out via a
 * fresh `node` process, which can't run TypeScript). We try two layouts:
 *
 *   1. Production / `dist/`:  this module is at `dist/server/server.js`,
 *      shim sits at `dist/cli/loom-invoke.js`.
 *   2. Dev / `src/` (tests):  this module is at `src/server/server.ts`;
 *      walk up to find a sibling `dist/cli/loom-invoke.js` (which exists
 *      whenever `npm run build` has been done).
 */
function findInvokeShim(): string {
  const here = fileURLToPath(import.meta.url);
  // Layout 1: ../cli/loom-invoke.js
  const sibling = path.join(
    path.dirname(path.dirname(here)),
    "cli",
    "loom-invoke.js",
  );
  if (existsSync(sibling)) return sibling;

  // Layout 2: walk up looking for dist/cli/loom-invoke.js
  let dir = path.dirname(here);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "dist", "cli", "loom-invoke.js");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `Could not locate loom-invoke shim. Tried ${sibling} and dist/cli/loom-invoke.js up the tree from ${here}. Run \`npm run build\` to produce it.`,
  );
}

/**
 * Materialize a per-server `bin/` directory with a `loom-invoke` shell
 * wrapper. Spawned tools can then call `loom-invoke <scope>` directly.
 *
 * Using a shell wrapper (rather than a symlink to the .js) avoids
 * depending on the .js having +x and a preserved shebang after tsc.
 */
async function provisionInvokeShim(parentDir: string): Promise<string> {
  const binDir = path.join(parentDir, "bin");
  await fs.mkdir(binDir, { recursive: true });
  const shimPath = path.join(binDir, "loom-invoke");
  const jsShim = findInvokeShim();
  const node = process.execPath;
  const script = `#!/bin/sh
exec ${shellQuote(node)} ${shellQuote(jsShim)} "$@"
`;
  await fs.writeFile(shimPath, script, { mode: 0o755 });
  return binDir;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
