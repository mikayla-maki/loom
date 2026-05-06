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
import { connectAcpUrl } from "../acp/client.js";
import { ndjsonStream, type MessageStream } from "../acp/framing.js";
import { ACP_METHODS, type JSONRPCRequest, type JSONRPCResponse } from "../acp/messages.js";

export interface DaemonOptions {
  socketPath?: string;
}

export interface BrokerTokenRecord {
  token: string;
  agentId: string;
  skill: string;
  allowedSubagents: Set<string>;
  /** Map of subagent name → resolved manifest path or acp:// URL. */
  registry: Record<string, string>;
}

/** Broker invocation params (token + scope shape used by tools). */
interface BrokerInvokeParams {
  token: string;
  scope: string;
  prompt: string;
}

export class GlassDaemon {
  public readonly socketPath: string;
  private readonly tokens = new Map<string, BrokerTokenRecord>();
  private readonly sessions = new Map<string, RunningAgent>();
  private nextSession = 1;
  private server: Server | null = null;

  constructor(options: DaemonOptions = {}) {
    this.socketPath = options.socketPath ?? defaultSocketPath();
  }

  /** Mint a per-tool token. */
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

  /** Validate a broker invocation; return the resolved manifest ref. */
  resolveInvocation(token: string, scope: string): string | null {
    const rec = this.tokens.get(token);
    if (!rec) return null;
    if (!rec.allowedSubagents.has(scope)) return null;
    return rec.registry[scope] ?? null;
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
    for (const [, agent] of this.sessions) {
      await agent.close().catch(() => undefined);
    }
    this.sessions.clear();
    try {
      await fs.unlink(this.socketPath);
    } catch {
      // ignore
    }
  }

  private handleConnection(sock: Socket): void {
    const stream = ndjsonStream(sock, sock);
    void this.serve(stream).catch(() => undefined);
  }

  private async serve(stream: MessageStream): Promise<void> {
    const localSessions = new Set<string>();
    const updateSubs = new Map<string, Promise<void>>();
    /** Outbound (agent → client) permission-request bookkeeping. */
    let nextOutId = 100000;
    const pendingOut = new Map<number, (v: import("../types/permissions.js").PermissionResult) => void>();

    const respond = (id: unknown, result: unknown) => {
      const r: JSONRPCResponse = {
        jsonrpc: "2.0",
        id: id as JSONRPCResponse["id"],
        result,
      };
      stream.write(JSON.stringify(r));
    };
    const respondError = (id: unknown, code: number, message: string) => {
      const r: JSONRPCResponse = {
        jsonrpc: "2.0",
        id: id as JSONRPCResponse["id"],
        error: { code, message },
      };
      stream.write(JSON.stringify(r));
    };

    /** Concurrent dispatch — see AcpRouter.run for the rationale. */
    const inflight = new Set<Promise<void>>();
    for await (const raw of stream.messages()) {
      if (typeof raw !== "object" || raw === null) continue;
      const msg = raw as JSONRPCRequest & JSONRPCResponse;

      // Inbound response to an outbound request (agent → client → us).
      if (
        typeof msg.id === "number" &&
        !msg.method &&
        (msg.result !== undefined || msg.error !== undefined) &&
        pendingOut.has(msg.id)
      ) {
        const cb = pendingOut.get(msg.id)!;
        pendingOut.delete(msg.id);
        if (msg.error) cb({ decision: "deny" });
        else cb(msg.result as import("../types/permissions.js").PermissionResult);
        continue;
      }

      const task = (async () => {
        const id = msg.id ?? null;
        try {
          // Broker shape: session/prompt with token+scope (no sessionId yet).
          if (
            msg.method === ACP_METHODS.sessionPrompt &&
            (msg.params as Partial<BrokerInvokeParams>)?.token &&
            (msg.params as Partial<BrokerInvokeParams>)?.scope
          ) {
            const params = msg.params as BrokerInvokeParams;
            const ref = this.resolveInvocation(params.token, params.scope);
            if (!ref) {
              respondError(id, -32001, "invalid token or scope");
              return;
            }
            const final = await this.runRefOnce(ref, params.prompt);
            respond(id, { stopReason: "end_turn", finalMessage: final });
            return;
          }

          switch (msg.method) {
          case ACP_METHODS.sessionNew: {
            const params = (msg.params ?? {}) as { manifestPath?: string; name?: string };
            let manifestPath = params.manifestPath;
            if (!manifestPath && params.name) {
              const { LocalRegistry } = await import("../registry/registry.js");
              const reg = new LocalRegistry();
              const r = await reg.lookup("agent", params.name);
              if (r) manifestPath = r;
            }
            if (!manifestPath) {
              respondError(id, -32602, "session/new requires manifestPath or registry name");
              break;
            }
            const agent = await runAgent(manifestPath);
            const sessionId = `s${this.nextSession++}`;
            this.sessions.set(sessionId, agent);
            localSessions.add(sessionId);
            // Forward agent permission requests to the connected client.
            agent.setPermissionHandler(async (req) => {
              const reqId = nextOutId++;
              return await new Promise((resolve) => {
                pendingOut.set(reqId, resolve);
                stream.write(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: reqId,
                    method: ACP_METHODS.sessionRequestPermission,
                    params: { sessionId, request: req },
                  }),
                );
              });
            });
            // Subscribe to updates and forward.
            const sub = agent.updates();
            const subPromise = (async () => {
              for await (const u of sub) {
                stream.write(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    method: ACP_METHODS.sessionUpdate,
                    params: { sessionId, update: u },
                  }),
                );
              }
            })().catch(() => undefined);
            updateSubs.set(sessionId, subPromise);
            respond(id, { sessionId, agentName: agent.resolved.manifest.agent.name });
            break;
          }

          case ACP_METHODS.sessionPrompt: {
            const params = (msg.params ?? {}) as { sessionId?: string; prompt?: string };
            const sid = params.sessionId;
            if (!sid) {
              respondError(id, -32602, "sessionId required");
              break;
            }
            const agent = this.sessions.get(sid);
            if (!agent) {
              respondError(id, -32004, `unknown sessionId: ${sid}`);
              break;
            }
            const stopReason = await agent.prompt(params.prompt ?? "");
            const events = await agent.session.getEvents();
            const last = [...events]
              .reverse()
              .find((e) => e.sessionUpdate === "agent_message_chunk");
            const finalMessage =
              last && last.content && last.content.type === "text" ? last.content.text : "";
            respond(id, { stopReason, finalMessage });
            break;
          }

          case ACP_METHODS.sessionCancel: {
            const sid = (msg.params as { sessionId?: string } | undefined)?.sessionId;
            if (sid) {
              const a = this.sessions.get(sid);
              if (a) await a.cancel();
            }
            respond(id, {});
            break;
          }

          case ACP_METHODS.sessionClose: {
            const sid = (msg.params as { sessionId?: string } | undefined)?.sessionId;
            if (sid) {
              const a = this.sessions.get(sid);
              if (a) {
                this.sessions.delete(sid);
                localSessions.delete(sid);
                await a.close().catch(() => undefined);
              }
            }
            respond(id, {});
            break;
          }

            default:
              respondError(id, -32601, `Method not found: ${msg.method}`);
          }
        } catch (e) {
          respondError(id, -32000, (e as Error).message);
        }
      })();
      inflight.add(task);
      task.finally(() => inflight.delete(task));
    }

    await Promise.allSettled(inflight);
    // Clean up sessions opened on this connection.
    for (const sid of localSessions) {
      const a = this.sessions.get(sid);
      if (a) {
        this.sessions.delete(sid);
        await a.close().catch(() => undefined);
      }
    }
  }

  private async runRefOnce(ref: string, prompt: string): Promise<string> {
    if (ref.startsWith("acp://") || ref.startsWith("acp+unix://")) {
      const c = await connectAcpUrl(ref);
      try {
        const ns = await c.newSession();
        const r = await c.prompt({ sessionId: ns.sessionId, prompt });
        return r.finalMessage ?? "";
      } finally {
        await c.close();
      }
    }
    const sub = await runAgent(ref);
    try {
      await sub.prompt(prompt);
      const events = await sub.session.getEvents();
      const last = [...events]
        .reverse()
        .find((e) => e.sessionUpdate === "agent_message_chunk");
      return last && last.content && last.content.type === "text" ? last.content.text : "";
    } finally {
      await sub.close();
    }
  }
}

function defaultSocketPath(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return path.join(xdg, "glass.sock");
  return path.join(os.tmpdir(), `glass-${process.getuid?.() ?? "u"}.sock`);
}

/** Run as a foreground daemon (CLI). */
export async function startDaemon(options: DaemonOptions = {}): Promise<never> {
  const d = new GlassDaemon(options);
  await d.start();
  process.stdout.write(`glass daemon listening on ${d.socketPath}\n`);
  process.on("SIGINT", () => {
    d.stop().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    d.stop().finally(() => process.exit(0));
  });
  return new Promise<never>(() => {
    void d;
  });
}
