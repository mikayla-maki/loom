/**
 * ACP wire types — JSON-RPC 2.0 framing of the Agent Client Protocol.
 *
 * The shape mirrors agentclientprotocol.com but is reduced to the surface
 * Loom actually uses:
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
}

export interface SessionPromptResult {
  stopReason: StopReason;
  /**
   * Cumulative token usage for this turn, when the harness reports it.
   * Mirrors the draft ACP RFD's `PromptResponse.usage` shape.
   */
  usage?: import("../types/acp.js").TurnUsage;
  /** Convenience: the final agent text message of the turn (best-effort). */
  finalMessage?: string;
}

export interface SessionUpdateNotification {
  sessionId: string;
  update: SessionUpdate;
}

export interface SessionNewParams {
  /** Path to an agent.toml. Mutually exclusive with `name`. */
  manifestPath?: string;
  /** Registry name (~/.loom/agents/<name>). Mutually exclusive with `manifestPath`. */
  name?: string;
}
export interface SessionNewResult {
  sessionId: string;
  agentName: string;
}

export interface SessionCancelParams {
  sessionId: string;
}

/**
 * `session/request_permission` — agent → client.
 *
 * Mirrors ACP's request-for-permission shape. The runtime forwards a
 * tool's permission request to the connected client; the client returns
 * a decision. Clients that don't implement the method MUST return an
 * error, which the runtime treats as a deny.
 */
export interface SessionRequestPermissionParams {
  sessionId: string;
  request: import("../types/permissions.js").PermissionRequest;
}
export interface SessionRequestPermissionResult {
  decision: import("../types/permissions.js").PermissionDecision;
}

export const ACP_METHODS = {
  sessionNew: "session/new",
  sessionPrompt: "session/prompt",
  sessionUpdate: "session/update",
  sessionCancel: "session/cancel",
  sessionClose: "session/close",
  sessionRequestPermission: "session/request_permission",
} as const;
