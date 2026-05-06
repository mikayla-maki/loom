/**
 * ACP wire types — JSON-RPC 2.0 framing of the Agent Client Protocol.
 *
 * The shape mirrors agentclientprotocol.com but is reduced to the surface
 * Glass actually uses:
 *   - session/prompt    (request)        client → agent
 *   - session/cancel    (notification)   client → agent
 *   - session/update    (notification)   agent → client
 *
 * Plus session/new (start a session by manifest path) for stand-alone runs.
 */

import type { SessionUpdate, StopReason } from "../types/acp.js";

export type JSONRPCId = number | string | null;

export interface JSONRPCRequest {
  jsonrpc: "2.0";
  id: JSONRPCId;
  method: string;
  params?: unknown;
}

export interface JSONRPCNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JSONRPCResponse<T = unknown> {
  jsonrpc: "2.0";
  id: JSONRPCId;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface SessionPromptParams {
  /** ACP session id (the agent's RunningAgent identifier). */
  sessionId?: string;
  prompt: string;
  /** v1 broker auth: token-and-broker invocation. */
  token?: string;
  /** v1: scope for sub-agent calls. */
  scope?: string;
}

export interface SessionPromptResult {
  stopReason: StopReason;
  /** Convenience: the final agent text message of the turn (best-effort). */
  finalMessage?: string;
}

export interface SessionUpdateNotification {
  sessionId: string;
  update: SessionUpdate;
}

export interface SessionNewParams {
  manifestPath: string;
}
export interface SessionNewResult {
  sessionId: string;
  agentName: string;
}

export interface SessionCancelParams {
  sessionId: string;
}

export const ACP_METHODS = {
  sessionNew: "session/new",
  sessionPrompt: "session/prompt",
  sessionUpdate: "session/update",
  sessionCancel: "session/cancel",
  sessionClose: "session/close",
} as const;
