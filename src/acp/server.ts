/**
 * ACP server — exposes a RunningAgent (or a manifest registry) over a
 * JSON-RPC stream.
 *
 * Two entry points:
 *
 *   serveOverStdio(agent)    — single-agent mode, pre-booted RunningAgent.
 *   AcpRouter                — multi-agent mode used by the daemon.
 *
 * The wire format is newline-delimited JSON-RPC 2.0.
 */

import { Readable, Writable } from "node:stream";

import type { RunningAgent } from "../sdk/running-agent.js";
import { runAgent } from "../sdk/run-agent.js";

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
} from "./messages.js";
import type { SessionUpdate } from "../types/acp.js";

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

  constructor(private readonly binding: ServeAgentBinding) {}

  /** Bind a pre-booted agent to a freshly assigned sessionId. */
  async bindSession(agent: RunningAgent, stream: MessageStream): Promise<string> {
    const sessionId = `s${this.nextId++}`;
    this.sessions.set(sessionId, agent);
    this.startUpdateForwarder(sessionId, agent, stream);
    return sessionId;
  }

  async run(stream: MessageStream, primarySessionId?: string): Promise<void> {
    for await (const raw of stream.messages()) {
      if (typeof raw !== "object" || raw === null) continue;
      const msg = raw as JSONRPCRequest;
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
    // Stream closed — clean up remaining sessions.
    for (const sid of [...this.sessions.keys()]) {
      await this.closeSession(sid);
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
    const events = await agent.session.getEvents();
    const last = [...events]
      .reverse()
      .find((e) => e.sessionUpdate === "agent_message_chunk");
    const finalMessage =
      last && last.content && last.content.type === "text" ? last.content.text : "";
    return { stopReason, finalMessage };
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
