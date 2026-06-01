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
  | { sessionUpdate: "stop"; stopReason: StopReason };

export interface PersistedUpdate {
  index: number;
  timestamp: string;
  update: SessionUpdate;
}
