/**
 * ACP-shaped session updates and protocol primitives.
 *
 * The Harness emits these as it runs a turn; the Session stores them; the
 * client consumes them via `RunningAgent.updates()`. The shape mirrors
 * agentclientprotocol.com so the SDK and the wire protocol can share types.
 */

/** Discriminated content blocks (mirrors ACP `ContentBlock`). */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource"; uri: string; mimeType?: string; text?: string };

export type ToolCallStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

/** ACP-style tool call content blocks. */
export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText: string; newText: string };

/** SessionUpdate — the unified vocabulary harnesses emit and sessions store. */
export type SessionUpdate =
  | {
      sessionUpdate: "user_message_chunk";
      content: ContentBlock;
    }
  | {
      sessionUpdate: "agent_message_chunk";
      content: ContentBlock;
    }
  | {
      sessionUpdate: "agent_thought_chunk";
      content: ContentBlock;
    }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title: string;
      kind?: string;
      status: ToolCallStatus;
      input?: unknown;
      content?: ToolCallContent[];
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      status?: ToolCallStatus;
      title?: string;
      content?: ToolCallContent[];
      output?: unknown;
    }
  | {
      sessionUpdate: "plan";
      entries: Array<{ content: string; priority?: string; status?: string }>;
    }
  | {
      sessionUpdate: "stop";
      stopReason: StopReason;
    };

/** Why a turn ended. */
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"
  | "error";

/** A persisted session update with monotonically increasing index + timestamp. */
export interface PersistedUpdate {
  index: number;
  timestamp: string;
  update: SessionUpdate;
}
