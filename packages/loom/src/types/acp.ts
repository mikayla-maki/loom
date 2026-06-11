import type {
  SessionUpdate as SDKSessionUpdate,
  StopReason as SDKStopReason,
} from "@agentclientprotocol/sdk";

export type {
  ContentBlock,
  EnvVariable,
  Plan,
  PlanEntry,
  PlanEntryPriority,
  PlanEntryStatus,
  ReadTextFileRequest,
  ReadTextFileResponse,
  SessionConfigId,
  SessionConfigOption,
  SessionConfigOptionCategory,
  SessionConfigValueId,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  TerminalExitStatus,
  TerminalOutputResponse,
  ToolCallContent,
  ToolCallId,
  ToolCallLocation,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
  Usage,
  UsageUpdate,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

// Loom's runtime `ToolCall` (dispatch shape) lives in interfaces.ts; this is the SDK wire shape.
export type { ToolCall as WireToolCall } from "@agentclientprotocol/sdk";

export { TerminalHandle } from "@agentclientprotocol/sdk";

import type { Usage } from "@agentclientprotocol/sdk";

// "error" is non-wire; the ACP server maps it to a JSON-RPC error response.
export type StopReason = SDKStopReason | "error";

export type TurnUsage = Usage;

// "stop" is non-wire; the ACP server strips it before forwarding to clients.
export type SessionUpdate =
  | SDKSessionUpdate
  | { sessionUpdate: "stop"; stopReason: StopReason }
  | FrameUpdate;

/**
 * Non-wire lifecycle framing for embedders (the ACP server strips these).
 *
 * Chunks alone don't tell a host where a turn or message begins and ends, or
 * which message a chunk belongs to. Frames carry that structure:
 *
 * - `turn_start` / `turn_end` are emitted by the runtime around each
 *   `prompt()` (turn_end follows the harness's `stop`, even on error).
 * - `message_start` / `message_end` are emitted by harnesses around each
 *   assistant message, and by the runtime around the user message it pushes
 *   for a prompt. `message_end` for an assistant message is emitted before
 *   any tool from that message executes, so hosts can rely on it as a
 *   barrier.
 *
 * Frames flow through `session.push` so layers can observe them, but the
 * built-in storage layers do not persist them: they are derivable structure,
 * not content, and persisting them would pollute replay.
 */
export interface FrameUpdate {
  sessionUpdate: "frame";
  frame: "turn_start" | "turn_end" | "message_start" | "message_end";
  /** Set on message frames; absent on turn frames. */
  role?: "user" | "assistant";
  /** Correlates chunks to a message; stable across start/end of one message. */
  messageId?: string;
  _meta?: Record<string, unknown>;
}

export interface PersistedUpdate {
  index: number;
  timestamp: string;
  update: SessionUpdate;
}
