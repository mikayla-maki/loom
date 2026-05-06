/**
 * Glass daemon — long-running broker.
 *
 * Holds the secrets vault decrypted in memory once, keeps loaded extensions
 * resident, and serves ACP clients over a Unix socket. Builds on top of
 * `AcpRouter` from src/acp/server.ts.
 *
 * v1: this module also implements the *token broker* used by sub-agent
 * invocation. Each running agent that hosts tools spawns those tools with
 * a per-tool GLASS_INVOKE_TOKEN bound to the tool's owning skill and the
 * sub-agents that skill is allowed to invoke. The daemon's broker resolves
 * the token, looks up the allowed sub-agents, and runs the requested one.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createServer, Server, Socket } from "node:net";
import { randomBytes } from "node:crypto";

import type { RunningAgent } from "../sdk/running-agent.js";
import { runAgent } from "../sdk/run-agent.js";
import { AcpRouter } from "../acp/server.js";
import { ndjsonStream } from "../acp/framing.js";

export interface DaemonOptions {
  /** Socket path. Defaults to $XDG_RUNTIME_DIR/glass.sock or /tmp/glass-<uid>.sock. */
  socketPath?: string;
}

export interface BrokerTokenRecord {
  token: string;
  agentId: string;
  skill: string;
  allowedSubagents: Set<string>;
  /** Map of subagent name → resolved manifest path (or acp URL). */
  registry: Record<string, string>;
}

export class GlassDaemon {
  public readonly socketPath: string;
  private readonly tokens = new Map<string, BrokerTokenRecord>();
  private readonly agents = new Map<string, RunningAgent>();
  private server: Server | null = null;

  constructor(options: DaemonOptions = {}) {
    this.socketPath =
      options.socketPath ?? defaultSocketPath();
  }

  /** Bind a running agent into the daemon and return its id. */
  registerAgent(agent: RunningAgent): string {
    const id = `a${this.agents.size + 1}`;
    this.agents.set(id, agent);
    return id;
  }

  /**
   * Mint a new broker token for an agent's skill. Tools that this agent
   * spawns can use the token to ask the daemon to run an allowed subagent.
   */
  mintToken(agentId: string, skill: string, registry: Record<string, string>): string {
    const token = "tok_" + randomBytes(16).toString("hex");
    this.tokens.set(token, {
      token,
      agentId,
      skill,
      allowedSubagents: new Set(Object.keys(registry)),
      registry,
    });
    return token;
  }

  revokeTokensForAgent(agentId: string): void {
    for (const [k, v] of this.tokens) {
      if (v.agentId === agentId) this.tokens.delete(k);
    }
  }

  /** Look up + validate an invocation request. Returns the manifest path / URL. */
  resolveInvocation(token: string, scope: string): {
    manifestRef: string;
    record: BrokerTokenRecord;
  } | null {
    const rec = this.tokens.get(token);
    if (!rec) return null;
    if (!rec.allowedSubagents.has(scope)) return null;
    const ref = rec.registry[scope];
    if (!ref) return null;
    return { manifestRef: ref, record: rec };
  }

  async start(): Promise<void> {
    await fs.mkdir(path.dirname(this.socketPath), { recursive: true });
    try {
      await fs.unlink(this.socketPath);
    } catch {
      // ignore
    }

    this.server = createServer((sock) => this.handleConnection(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((r) => this.server!.close(() => r()));
      this.server = null;
    }
    try {
      await fs.unlink(this.socketPath);
    } catch {
      // ignore
    }
  }

  private handleConnection(sock: Socket): void {
    const stream = ndjsonStream(sock, sock);
    const router = new AcpRouter({
      agentFactory: async (manifestPath?: string) => {
        if (!manifestPath) throw new Error("manifestPath required");
        return await runAgent(manifestPath);
      },
    });

    // Add a small JSON-RPC layer that ALSO understands the broker invocation
    // shape used by `glass-spawn-subagent`: `session/prompt` with a token
    // and a scope. We intercept it here before delegating.
    void (async () => {
      for await (const raw of stream.messages()) {
        if (typeof raw !== "object" || raw === null) continue;
        const msg = raw as {
          jsonrpc?: string;
          id?: number | string | null;
          method?: string;
          params?: { token?: string; scope?: string; prompt?: string; sessionId?: string; manifestPath?: string };
        };
        if (msg.method === "session/prompt" && msg.params?.token && msg.params.scope) {
          const lookup = this.resolveInvocation(msg.params.token, msg.params.scope);
          if (!lookup) {
            stream.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id ?? null,
                error: { code: -32001, message: "invalid token or scope" },
              }),
            );
            continue;
          }
          const manifestRef = lookup.manifestRef;
          try {
            // For now: only path / acp:// are supported as registry values.
            let final = "";
            if (manifestRef.startsWith("acp://") || manifestRef.startsWith("acp+unix://")) {
              const { connectAcpUrl } = await import("../acp/client.js");
              const c = await connectAcpUrl(manifestRef);
              const ns = await c.newSession();
              const r = await c.prompt({
                sessionId: ns.sessionId,
                prompt: msg.params.prompt ?? "",
              });
              final = r.finalMessage ?? "";
              await c.close();
            } else {
              const sub = await runAgent(manifestRef);
              try {
                await sub.prompt(msg.params.prompt ?? "");
                const events = await sub.session.getEvents();
                const last = [...events]
                  .reverse()
                  .find((e) => e.sessionUpdate === "agent_message_chunk");
                final =
                  last && last.content && last.content.type === "text" ? last.content.text : "";
              } finally {
                await sub.close();
              }
            }
            stream.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id ?? null,
                result: { stopReason: "end_turn", finalMessage: final },
              }),
            );
          } catch (e) {
            stream.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id ?? null,
                error: { code: -32000, message: (e as Error).message },
              }),
            );
          }
          continue;
        }
        // Otherwise: re-emit through the router by feeding it back. Easier:
        // build a tiny synthetic stream that replays this single message
        // and is then closed; but in practice we can simply delegate with a
        // shared queue. For v1 simplicity, we'll forward to the router via
        // a fresh short-lived stream-like.
        // → Run the router for plain ACP traffic on a separate code path:
        // here we just reply "method not found" if we don't recognize.
        // For complete ACP routing on the daemon socket, callers should
        // use connectUnix(daemon.socketPath) and use session/new etc; the
        // router below handles that.
        await routeOne(router, raw, stream);
      }
    })();
  }
}

async function routeOne(router: AcpRouter, raw: unknown, stream: import("../acp/framing.js").MessageStream): Promise<void> {
  // Build a single-shot stream: emits one message then ends.
  const queue: unknown[] = [raw];
  let ended = false;
  const fakeIn: import("../acp/framing.js").MessageStream = {
    write: (line) => stream.write(line),
    async *messages() {
      while (queue.length > 0) yield queue.shift();
      ended = true;
    },
    close() {
      ended = true;
    },
  };
  // Don't await — router.run loops over messages(); we just need it to
  // emit responses to the original stream and return.
  await router.run(fakeIn);
}

function defaultSocketPath(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return path.join(xdg, "glass.sock");
  return path.join(os.tmpdir(), `glass-${process.getuid?.() ?? "unknown"}.sock`);
}

export async function startDaemon(options: DaemonOptions = {}): Promise<GlassDaemon> {
  const d = new GlassDaemon(options);
  await d.start();
  process.stdout.write(`glass daemon listening on ${d.socketPath}\n`);
  process.on("SIGINT", () => {
    d.stop().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    d.stop().finally(() => process.exit(0));
  });
  // Hold the process forever.
  return new Promise<GlassDaemon>(() => {
    void d;
  });
}
