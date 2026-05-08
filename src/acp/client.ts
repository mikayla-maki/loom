/**
 * ACP client — drives a remote agent over JSON-RPC.
 *
 * Three transports:
 *   - connectStdio(child)        — child process speaking ACP on stdio
 *   - connectUnix(socketPath)    — Unix socket
 *   - connectAcpUrl(url)         — generic dispatcher: acp://host:port,
 *                                   acp+unix://path
 */

import { spawn, ChildProcess } from "node:child_process";
import { connect, Socket } from "node:net";

import { ndjsonStream, type MessageStream } from "./framing.js";
import {
  ACP_METHODS,
  type JSONRPCRequest,
  type JSONRPCResponse,
  type SessionNewResult,
  type SessionPromptParams,
  type SessionPromptResult,
} from "./messages.js";
import type { SessionUpdate } from "../types/acp.js";

export interface AcpClient {
  newSession(manifestPathOrName?: string, opts?: { byName?: boolean }): Promise<SessionNewResult>;
  prompt(params: SessionPromptParams): Promise<SessionPromptResult>;
  cancel(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  /** Subscribe to update notifications for a session. */
  updates(sessionId: string): AsyncIterableIterator<SessionUpdate>;
  /**
   * Register a handler invoked when the agent requests permission to expand
   * its declared scope (or perform any other consent-gated operation).
   * If no handler is set, the client returns method-not-found, which the
   * server interprets as a deny.
   */
  setPermissionHandler(
    handler:
      | ((req: import("../types/permissions.js").PermissionRequest) => Promise<import("../types/permissions.js").PermissionResult> | import("../types/permissions.js").PermissionResult)
      | null,
  ): void;
  close(): Promise<void>;
}

type PermissionHandlerCb = (
  req: import("../types/permissions.js").PermissionRequest,
) =>
  | Promise<import("../types/permissions.js").PermissionResult>
  | import("../types/permissions.js").PermissionResult;

class JsonRpcClient implements AcpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly subs = new Map<
    string,
    Array<(u: SessionUpdate) => void>
  >();
  private readonly subEnded = new Map<string, () => void>();
  private permissionHandler: PermissionHandlerCb | null = null;
  private closed = false;

  constructor(private readonly stream: MessageStream, private readonly cleanup?: () => void) {
    void this.pump();
  }

  setPermissionHandler(handler: PermissionHandlerCb | null): void {
    this.permissionHandler = handler;
  }

  private async pump(): Promise<void> {
    for await (const raw of this.stream.messages()) {
      if (typeof raw !== "object" || raw === null) continue;
      const m = raw as JSONRPCRequest & JSONRPCResponse;

      // Inbound *request* from the agent — currently only
      // session/request_permission.
      if (
        "method" in m &&
        m.method === ACP_METHODS.sessionRequestPermission &&
        typeof m.id === "number"
      ) {
        const params = m.params as {
          sessionId: string;
          request: import("../types/permissions.js").PermissionRequest;
        };
        if (!this.permissionHandler) {
          this.stream.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: m.id,
              error: { code: -32601, message: "session/request_permission not implemented" },
            }),
          );
          continue;
        }
        try {
          const result = await Promise.resolve(this.permissionHandler(params.request));
          this.stream.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: m.id,
              result,
            }),
          );
        } catch (e) {
          this.stream.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: m.id,
              error: { code: -32000, message: (e as Error).message },
            }),
          );
        }
        continue;
      }

      if ("method" in m && m.method === ACP_METHODS.sessionUpdate) {
        const params = m.params as { sessionId: string; update: SessionUpdate };
        const subs = this.subs.get(params.sessionId);
        if (subs) for (const s of subs) s(params.update);
        continue;
      }
      if (typeof m.id === "number") {
        const p = this.pending.get(m.id);
        if (!p) continue;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      }
    }
    this.closed = true;
    for (const ender of this.subEnded.values()) ender();
  }

  private call<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("client is closed"));
    const id = this.nextId++;
    const req: JSONRPCRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.stream.write(JSON.stringify(req));
    });
  }

  async newSession(
    manifestPathOrName?: string,
    opts: { byName?: boolean } = {},
  ): Promise<SessionNewResult> {
    const params = opts.byName
      ? { name: manifestPathOrName }
      : { manifestPath: manifestPathOrName };
    return this.call<SessionNewResult>(ACP_METHODS.sessionNew, params);
  }

  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    return this.call<SessionPromptResult>(ACP_METHODS.sessionPrompt, params);
  }

  async cancel(sessionId: string): Promise<void> {
    await this.call(ACP_METHODS.sessionCancel, { sessionId });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.call(ACP_METHODS.sessionClose, { sessionId });
  }

  updates(sessionId: string): AsyncIterableIterator<SessionUpdate> {
    const queue: SessionUpdate[] = [];
    let resolveNext: ((v: IteratorResult<SessionUpdate>) => void) | null = null;
    let ended = false;

    const subs = this.subs.get(sessionId) ?? [];
    const cb = (u: SessionUpdate) => {
      if (resolveNext) {
        resolveNext({ value: u, done: false });
        resolveNext = null;
      } else {
        queue.push(u);
      }
    };
    subs.push(cb);
    this.subs.set(sessionId, subs);
    this.subEnded.set(sessionId, () => {
      ended = true;
      if (resolveNext) {
        resolveNext({ value: undefined as unknown as SessionUpdate, done: true });
        resolveNext = null;
      }
    });

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<SessionUpdate>> {
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift()!, done: false });
        }
        if (ended) {
          return Promise.resolve({ value: undefined as unknown as SessionUpdate, done: true });
        }
        return new Promise((resolve) => {
          resolveNext = resolve;
        });
      },
      return(): Promise<IteratorResult<SessionUpdate>> {
        ended = true;
        const list = subs.filter((c) => c !== cb);
        if (list.length === 0) this.subs?.delete(sessionId);
        else this.subs?.set(sessionId, list);
        return Promise.resolve({ value: undefined as unknown as SessionUpdate, done: true });
      },
    } as AsyncIterableIterator<SessionUpdate> & { subs?: Map<string, unknown> };
  }

  async close(): Promise<void> {
    this.stream.close();
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("client closed"));
    this.pending.clear();
    if (this.cleanup) this.cleanup();
  }
}

export function connectStdio(child: ChildProcess): AcpClient {
  if (!child.stdin || !child.stdout) {
    throw new Error("ChildProcess must have piped stdin/stdout");
  }
  const stream = ndjsonStream(child.stdout, child.stdin);
  return new JsonRpcClient(stream, () => {
    try {
      child.kill();
    } catch {
      // ignore
    }
  });
}

export function spawnAcpServer(command: string, args: string[]): AcpClient {
  const child: ChildProcess = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
  });
  return connectStdio(child);
}

export function connectUnix(socketPath: string): Promise<AcpClient> {
  return new Promise<AcpClient>((resolve, reject) => {
    const s: Socket = connect(socketPath);
    s.once("connect", () => {
      const stream = ndjsonStream(s, s);
      resolve(new JsonRpcClient(stream, () => s.destroy()));
    });
    s.once("error", reject);
  });
}

export interface ParsedAcpUrl {
  scheme: "acp" | "acp+unix";
  /** For acp+unix: the socket path (everything between scheme:// and the next '/' delimiter). */
  socketPath?: string;
  host?: string;
  port?: number;
  /** Path component (e.g. "/search") — used as the registry name on the remote daemon. */
  agentName?: string;
}

/**
 * Parse an ACP URL.
 *
 * Examples:
 *   acp://192.168.1.5:8910/search       → { scheme: acp, host, port, agentName: 'search' }
 *   acp+unix:///run/loom.sock          → { scheme: acp+unix, socketPath: '/run/loom.sock' }
 *   acp+unix:///run/loom.sock:helper   → { scheme: acp+unix, socketPath: '/run/loom.sock', agentName: 'helper' }
 *
 * The acp+unix variant uses ':' as the socket-vs-name separator because Unix
 * paths can contain '/'. Either or both halves may be omitted.
 */
export function parseAcpUrl(url: string): ParsedAcpUrl {
  if (url.startsWith("acp+unix://")) {
    const tail = url.slice("acp+unix://".length);
    const colon = tail.lastIndexOf(":");
    if (colon > 0) {
      return {
        scheme: "acp+unix",
        socketPath: tail.slice(0, colon),
        agentName: tail.slice(colon + 1),
      };
    }
    return { scheme: "acp+unix", socketPath: tail };
  }
  if (url.startsWith("acp://")) {
    const tail = url.slice("acp://".length);
    const m = /^([^:/]+):(\d+)(\/.*)?$/.exec(tail);
    if (!m) throw new Error(`invalid acp:// URL: ${url}`);
    const out: ParsedAcpUrl = { scheme: "acp", host: m[1]!, port: parseInt(m[2]!, 10) };
    if (m[3]) out.agentName = m[3].replace(/^\//, "");
    return out;
  }
  throw new Error(`unsupported ACP URL scheme: ${url}`);
}

export async function connectAcpUrl(url: string): Promise<AcpClient & { agentName?: string }> {
  const parsed = parseAcpUrl(url);
  if (parsed.scheme === "acp+unix") {
    const c = (await connectUnix(parsed.socketPath!)) as AcpClient & { agentName?: string };
    if (parsed.agentName) c.agentName = parsed.agentName;
    return c;
  }
  // acp://
  const host = parsed.host!;
  const port = parsed.port!;
  return await new Promise<AcpClient & { agentName?: string }>((resolve, reject) => {
    const s = connect(port, host);
    s.once("connect", () => {
      const stream = ndjsonStream(s, s);
      const c: AcpClient & { agentName?: string } = new JsonRpcClient(stream, () => s.destroy());
      if (parsed.agentName) c.agentName = parsed.agentName;
      resolve(c);
    });
    s.once("error", reject);
  });
}
