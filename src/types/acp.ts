/**
 * ACP wire types — re-exported from `@agentclientprotocol/sdk`.
 *
 * Loom used to maintain its own ACP-shaped types; now it consumes the
 * SDK's generated types verbatim so wire conformance is automatic.
 *
 * One small extension: Loom's `SessionUpdate` union includes a
 * `"stop"` variant the SDK does not model. Harnesses emit it to mark
 * turn end inside the session update stream; the ACP server filters
 * stops out before forwarding so the wire stays standards-conformant.
 */

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

// Note: the SDK's `ToolCall` (wire shape) is intentionally NOT
// re-exported here. Loom's runtime defines its own `ToolCall`
// (dispatch shape) in `interfaces.ts`. Import the SDK's directly via
// `import type { ToolCall } from "@agentclientprotocol/sdk"` if you
// need the wire shape (e.g. when constructing a `SessionUpdate`).
export type { ToolCall as WireToolCall } from "@agentclientprotocol/sdk";

// `TerminalHandle` is a class — re-exported here as the canonical type
// for ACP terminals. Loom's `ClientBridge.createTerminal` resolves to
// one of these. Tools call `currentOutput()` / `waitForExit()` /
// `kill()` / `release()` on the handle; the SDK owns the JSON-RPC
// plumbing underneath.
export { TerminalHandle } from "@agentclientprotocol/sdk";

import type { Usage } from "@agentclientprotocol/sdk";

/**
 * Why a turn ended. Loom extends the SDK's `StopReason` enum with a
 * non-wire `"error"` value used internally by harnesses to signal
 * unexpected exits (network failure, malformed response, etc.). The
 * ACP server maps `"error"` to a JSON-RPC error response rather than
 * a normal `PromptResponse.stopReason` value.
 */
export type StopReason = SDKStopReason | "error";

/**
 * Per-turn cumulative token breakdown. Carries the SDK's `Usage`
 * shape (with `totalTokens`); the old Loom-specific shape is gone.
 */
export type TurnUsage = Usage;

/**
 * Loom-internal `SessionUpdate` extension: adds a `"stop"` variant so
 * harnesses can mark turn boundaries in the update log. The ACP
 * server strips `"stop"` updates before forwarding to clients (the
 * wire signals turn end via `PromptResponse.stopReason`).
 */
export type SessionUpdate =
  | SDKSessionUpdate
  | { sessionUpdate: "stop"; stopReason: StopReason };

/** A persisted session update with monotonically increasing index + timestamp. */
export interface PersistedUpdate {
  index: number;
  timestamp: string;
  update: SessionUpdate;
}
