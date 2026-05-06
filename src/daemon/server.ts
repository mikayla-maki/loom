/**
 * Glass daemon — long-running ACP broker.
 *
 * Holds RunningAgent sessions resident across requests so subagent calls
 * skip the cold-start cost. v1 token-broker entry point: tools are spawned
 * with a per-skill token bound to the subagents that skill is allowed to
 * invoke; `session/prompt { token, scope, prompt }` validates the token
 * and runs the resolved manifest (or forwards via acp:// for chained
 * network-located trees).
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
import { lastAgentMessage } from "../runtime/extract-message.js";
import type { PermissionResult } from "../types/permissions.js";

export interface DaemonOptions {
  socketPath?: string;
}

export interface BrokerTokenRecord {
  agentId: string;
  skill: string;
  /** Map of subagent name → manifest path or acp:// URL. */
  registry: Record<string, string>;
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

  mintToken(agentId: string, skill: string, registry: Record<string, string>): string {
    const token = "tok_" + randomBytes(16).toString("hex");
    this.tokens.set(token, { agentId, skill, registry });
    return token;
  }

  revokeTokensForAgent(agentId: string): void {
    for (const [k, v] of this.tokens) {
      if (v.agentId === agentId) this.tokens.delete(k);
    }
  }

  /** Validate a broker invocation; returns the manifest path / URL or null. */
  resolveInvocation(token: string, scope: string): string | null {
    const rec = this.tokens.get(token);
    if (!rec || !(scope in rec.registry)) return null;
    return rec.registry[scope] ?? null;
  }

  async start(): Promise<void> {
    await fs.mkdir(path.dirname(this.socketPath), { recursive: true });
    await unlinkIfExists(this.socketPath);
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
    await unlinkIfExists(this.socketPath);
  }

  private handleConnection(sock: Socket): void {
    void this.serve(ndjsonStream(sock, sock)).catch(() => undefined);
  }

  private async serve(stream: MessageStream): Promise<void> {
    const localSessions = new Set<string>();
    /** Outbound (agent → client) request bookkeeping (e.g. permission). */
    let nextOutId = 100000;
    const pendingOut = new Map<number, (v: PermissionResult) => void>();

    const respond = (id: unknown, result: unknown) =>
      stream.write(JSON.stringify({ jsonrpc: "2.0", id: id as JSONRPCResponse["id"], result }));
    const respondError = (id: unknown, code: number, message: string) =>
      stream.write(JSON.stringify({
        jsonrpc: "2.0",
        id: id as JSONRPCResponse["id"],
        error: { code, message },
      }));

    const inflight = new Set<Promise<void>>();
    for await (const raw of stream.messages()) {
      if (typeof raw !== "object" || raw === null) continue;
      const msg = raw as JSONRPCRequest & JSONRPCResponse;

      // Inbound response to one of our outbound requests.
      if (
        typeof msg.id === "number" &&
        !msg.method &&
        (msg.result !== undefined || msg.error !== undefined) &&
        pendingOut.has(msg.id)
      ) {
        const cb = pendingOut.get(msg.id)!;
        pendingOut.delete(msg.id);
        cb(msg.error ? { decision: "deny" } : (msg.result as PermissionResult));
        continue;
      }

      const task = this.dispatch(msg, stream, {
        respond,
        respondError,
        localSessions,
        outbound: { next: () => nextOutId++, pending: pendingOut },
      });
      inflight.add(task);
      task.finally(() => inflight.delete(task));
    }

    await Promise.allSettled(inflight);
    for (const sid of localSessions) {
      const a = this.sessions.get(sid);
      if (a) {
        this.sessions.delete(sid);
        await a.close().catch(() => undefined);
      }
    }
  }

  private async dispatch(
    msg: JSONRPCRequest,
    stream: MessageStream,
    ctx: {
      respond: (id: unknown, result: unknown) => void;
      respondError: (id: unknown, code: number, message: string) => void;
      localSessions: Set<string>;
      outbound: { next: () => number; pending: Map<number, (v: PermissionResult) => void> };
    },
  ): Promise<void> {
    const id = msg.id ?? null;
    try {
      // Broker invocation: session/prompt with token + scope.
      const params = (msg.params ?? {}) as Record<string, unknown>;
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
        const final = await this.runRefOnce(ref, String(params.prompt ?? ""));
        ctx.respond(id, { stopReason: "end_turn", finalMessage: final });
        return;
      }

      switch (msg.method) {
        case ACP_METHODS.sessionNew:
          return await this.handleSessionNew(id, params, stream, ctx);
        case ACP_METHODS.sessionPrompt:
          return await this.handleSessionPrompt(id, params, ctx);
        case ACP_METHODS.sessionCancel: {
          const sid = (params as { sessionId?: string }).sessionId;
          if (sid) await this.sessions.get(sid)?.cancel();
          ctx.respond(id, {});
          return;
        }
        case ACP_METHODS.sessionClose: {
          const sid = (params as { sessionId?: string }).sessionId;
          if (sid) await this.closeSession(sid, ctx.localSessions);
          ctx.respond(id, {});
          return;
        }
        default:
          ctx.respondError(id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (e) {
      ctx.respondError(id, -32000, (e as Error).message);
    }
  }

  private async handleSessionNew(
    id: unknown,
    params: Record<string, unknown>,
    stream: MessageStream,
    ctx: {
      respond: (id: unknown, result: unknown) => void;
      respondError: (id: unknown, code: number, message: string) => void;
      localSessions: Set<string>;
      outbound: { next: () => number; pending: Map<number, (v: PermissionResult) => void> };
    },
  ): Promise<void> {
    let manifestPath = typeof params.manifestPath === "string" ? params.manifestPath : undefined;
    if (!manifestPath && typeof params.name === "string") {
      const { LocalRegistry } = await import("../registry/registry.js");
      const hit = await new LocalRegistry().lookup("agent", params.name);
      if (hit) manifestPath = hit;
    }
    if (!manifestPath) {
      ctx.respondError(id, -32602, "session/new requires manifestPath or registry name");
      return;
    }

    const agent = await runAgent(manifestPath);
    const sessionId = `s${this.nextSession++}`;
    this.sessions.set(sessionId, agent);
    ctx.localSessions.add(sessionId);

    agent.setPermissionHandler(
      (req) =>
        new Promise<PermissionResult>((resolve) => {
          const reqId = ctx.outbound.next();
          ctx.outbound.pending.set(reqId, resolve);
          stream.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: reqId,
              method: ACP_METHODS.sessionRequestPermission,
              params: { sessionId, request: req },
            }),
          );
        }),
    );

    void (async () => {
      for await (const u of agent.updates()) {
        stream.write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: ACP_METHODS.sessionUpdate,
            params: { sessionId, update: u },
          }),
        );
      }
    })().catch(() => undefined);

    ctx.respond(id, { sessionId, agentName: agent.resolved.manifest.agent.name });
  }

  private async handleSessionPrompt(
    id: unknown,
    params: Record<string, unknown>,
    ctx: { respond: (id: unknown, result: unknown) => void; respondError: (id: unknown, code: number, message: string) => void },
  ): Promise<void> {
    const sid = typeof params.sessionId === "string" ? params.sessionId : undefined;
    if (!sid) {
      ctx.respondError(id, -32602, "sessionId required");
      return;
    }
    const agent = this.sessions.get(sid);
    if (!agent) {
      ctx.respondError(id, -32004, `unknown sessionId: ${sid}`);
      return;
    }
    const stopReason = await agent.prompt(String(params.prompt ?? ""));
    ctx.respond(id, { stopReason, finalMessage: await lastAgentMessage(agent.session) });
  }

  private async closeSession(sid: string, localSessions: Set<string>): Promise<void> {
    const a = this.sessions.get(sid);
    if (!a) return;
    this.sessions.delete(sid);
    localSessions.delete(sid);
    await a.close().catch(() => undefined);
  }

  private async runRefOnce(ref: string, prompt: string): Promise<string> {
    if (ref.startsWith("acp://") || ref.startsWith("acp+unix://")) {
      const c = await connectAcpUrl(ref);
      try {
        const ns = await c.newSession();
        return (await c.prompt({ sessionId: ns.sessionId, prompt })).finalMessage ?? "";
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
}

function defaultSocketPath(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return path.join(xdg, "glass.sock");
  return path.join(os.tmpdir(), `glass-${process.getuid?.() ?? "u"}.sock`);
}

async function unlinkIfExists(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    /* ignore */
  }
}

export async function startDaemon(options: DaemonOptions = {}): Promise<never> {
  const d = new GlassDaemon(options);
  await d.start();
  process.stdout.write(`glass daemon listening on ${d.socketPath}\n`);
  const shutdown = () => d.stop().finally(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise<never>(() => {});
}
