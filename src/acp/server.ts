/**
 * ACP server. Two entry points:
 *
 *   serveOverStdio(agent)  — single-agent stdio loop (pre-booted agent)
 *   AcpRouter              — multi-agent dispatcher used by the daemon
 *
 * Framing is newline-delimited JSON-RPC 2.0. Inbound dispatch is concurrent
 * because a `session/prompt` may issue an outbound `session/request_permission`
 * on the same connection and await the reply — serial dispatch deadlocks.
 */

import type { Readable, Writable } from "node:stream";

import type { RunningAgent } from "../sdk/running-agent.js";

import { ndjsonStream, type MessageStream } from "./framing.js";
import {
  ACP_METHODS,
  type JSONRPCRequest,
  type JSONRPCResponse,
  type SessionCancelParams,
  type SessionNewParams,
  type SessionNewResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type SessionRequestPermissionParams,
  type SessionRequestPermissionResult,
} from "./messages.js";
import { lastAgentMessage } from "../runtime/extract-message.js";
import type { SessionUpdate } from "../types/acp.js";
import type {
  PermissionHandler,
  PermissionRequest,
  PermissionResult,
} from "../types/permissions.js";

interface ServeAgentBinding {
  /** A pre-booted agent, or a factory that produces one on demand. */
  agentFactory: (manifestPath?: string) => Promise<RunningAgent>;
  /** If true, every session/new must explicitly target the given path. */
  fixedManifestPath?: string;
}

/** Run an ACP server over stdio for the lifetime of one RunningAgent. */
export async function serveOverStdio(agent: RunningAgent): Promise<void> {
  const stream = ndjsonStream(process.stdin, process.stdout);
  const router = new AcpRouter({
    agentFactory: async () => agent,
    fixedManifestPath: agent.resolved.manifest.manifestPath,
  });
  const sessionId = await router.bindSession(agent, stream);
  await router.run(stream, sessionId);
}

/** Server router used by both stdio and daemon transports. */
export class AcpRouter {
  private readonly sessions = new Map<string, RunningAgent>();
  private readonly subscriptions = new Map<string, Promise<void>>();
  private nextId = 1;
  /** Outgoing request-id counter (server → client). */
  private nextOutId = 10000;
  /** Pending agent→client requests by id. */
  private readonly pendingOutbound = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly binding: ServeAgentBinding) {}

  /** Bind a pre-booted agent to a freshly assigned sessionId. */
  async bindSession(agent: RunningAgent, stream: MessageStream): Promise<string> {
    const sessionId = `s${this.nextId++}`;
    this.sessions.set(sessionId, agent);
    this.startUpdateForwarder(sessionId, agent, stream);
    // Wire the agent's permission requests to the connected client.
    agent.setPermissionHandler(this.makeForwardingPermissionHandler(sessionId, stream));
    return sessionId;
  }

  /**
   * Build a PermissionHandler that, when invoked, sends a JSON-RPC request
   * to the connected client and awaits the result. If the client doesn't
   * implement `session/request_permission` (returns method-not-found) we
   * treat that as a deny — the safe default.
   */
  private makeForwardingPermissionHandler(
    sessionId: string,
    stream: MessageStream,
  ): PermissionHandler {
    return async (req: PermissionRequest): Promise<PermissionResult> => {
      const id = this.nextOutId++;
      const envelope = {
        jsonrpc: "2.0",
        id,
        method: ACP_METHODS.sessionRequestPermission,
        params: {
          sessionId,
          request: req,
        } satisfies SessionRequestPermissionParams,
      };
      const reply = await new Promise<unknown>((resolve, reject) => {
        this.pendingOutbound.set(id, { resolve, reject });
        stream.write(JSON.stringify(envelope));
      }).catch((e) => {
        return { error: e };
      });
      if (reply && typeof reply === "object" && "decision" in (reply as Record<string, unknown>)) {
        return reply as SessionRequestPermissionResult;
      }
      return { decision: "deny" };
    };
  }

  async run(stream: MessageStream, primarySessionId?: string): Promise<void> {
    const inflight = new Set<Promise<void>>();
    for await (const raw of stream.messages()) {
      if (typeof raw !== "object" || raw === null) continue;
      const msg = raw as JSONRPCRequest & JSONRPCResponse;

      // Inbound response to one of OUR outbound requests (e.g. permission).
      if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
        const pending = this.pendingOutbound.get(msg.id);
        if (pending) {
          this.pendingOutbound.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error.message));
          else pending.resolve(msg.result);
        }
        continue;
      }

      const task = this.dispatch(msg, stream, primarySessionId);
      inflight.add(task);
      task.finally(() => inflight.delete(task));
    }
    // Stream closed — wait for any in-flight handlers, then clean up sessions.
    await Promise.allSettled(inflight);
    for (const sid of [...this.sessions.keys()]) {
      await this.closeSession(sid);
    }
  }

  private async dispatch(
    msg: JSONRPCRequest,
    stream: MessageStream,
    primarySessionId?: string,
  ): Promise<void> {
    const id = msg.id ?? null;
    try {
      switch (msg.method) {
        case ACP_METHODS.sessionNew: {
          const result = await this.handleSessionNew(
            (msg.params ?? {}) as SessionNewParams,
            stream,
          );
          this.respond(stream, id, result);
          break;
        }
        case ACP_METHODS.sessionPrompt: {
          const result = await this.handleSessionPrompt(
            (msg.params ?? {}) as SessionPromptParams,
            primarySessionId,
          );
          this.respond(stream, id, result);
          break;
        }
        case ACP_METHODS.sessionCancel: {
          await this.handleSessionCancel((msg.params ?? {}) as SessionCancelParams);
          this.respond(stream, id, {});
          break;
        }
        case ACP_METHODS.sessionClose: {
          const sid = (msg.params as { sessionId?: string } | undefined)?.sessionId;
          if (sid) await this.closeSession(sid);
          this.respond(stream, id, {});
          break;
        }
        default:
          this.respondError(stream, id, -32601, `Method not found: ${msg.method}`);
      }
    } catch (e) {
      this.respondError(stream, id, -32000, (e as Error).message);
    }
  }

  private async handleSessionNew(
    params: SessionNewParams,
    stream: MessageStream,
  ): Promise<SessionNewResult> {
    const path = this.binding.fixedManifestPath ?? params.manifestPath;
    if (!path) throw new Error("session/new requires manifestPath");
    const agent = await this.binding.agentFactory(path);
    const sessionId = `s${this.nextId++}`;
    this.sessions.set(sessionId, agent);
    this.startUpdateForwarder(sessionId, agent, stream);
    return { sessionId, agentName: agent.resolved.manifest.agent.name };
  }

  private async handleSessionPrompt(
    params: SessionPromptParams,
    fallbackSessionId?: string,
  ): Promise<SessionPromptResult> {
    const sid = params.sessionId ?? fallbackSessionId;
    if (!sid) throw new Error("session/prompt requires sessionId");
    const agent = this.sessions.get(sid);
    if (!agent) throw new Error(`unknown sessionId: ${sid}`);
    const stopReason = await agent.prompt(params.prompt);
    return { stopReason, finalMessage: await lastAgentMessage(agent.session) };
  }

  private async handleSessionCancel(params: SessionCancelParams): Promise<void> {
    const agent = this.sessions.get(params.sessionId);
    if (agent) await agent.cancel();
  }

  private async closeSession(sid: string): Promise<void> {
    const agent = this.sessions.get(sid);
    if (!agent) return;
    this.sessions.delete(sid);
    await agent.close().catch(() => undefined);
    await this.subscriptions.get(sid)?.catch(() => undefined);
    this.subscriptions.delete(sid);
  }

  private startUpdateForwarder(
    sessionId: string,
    agent: RunningAgent,
    stream: MessageStream,
  ): void {
    const promise = (async () => {
      const sub = agent.updates();
      for await (const u of sub) {
        const note = {
          jsonrpc: "2.0",
          method: ACP_METHODS.sessionUpdate,
          params: { sessionId, update: u } satisfies { sessionId: string; update: SessionUpdate },
        };
        stream.write(JSON.stringify(note));
      }
    })().catch(() => undefined);
    this.subscriptions.set(sessionId, promise);
  }

  private respond(stream: MessageStream, id: unknown, result: unknown): void {
    const r: JSONRPCResponse = {
      jsonrpc: "2.0",
      id: id as JSONRPCResponse["id"],
      result,
    };
    stream.write(JSON.stringify(r));
  }
  private respondError(stream: MessageStream, id: unknown, code: number, message: string): void {
    const r: JSONRPCResponse = {
      jsonrpc: "2.0",
      id: id as JSONRPCResponse["id"],
      error: { code, message },
    };
    stream.write(JSON.stringify(r));
  }
}

/** Convenience: run an AcpRouter over a custom Readable+Writable pair. */
export function routerOverStreams(
  router: AcpRouter,
  input: Readable,
  output: Writable,
): Promise<void> {
  const stream = ndjsonStream(input, output);
  return router.run(stream);
}
