/**
 * Anthropic harness — calls the Messages API directly via fetch.
 *
 * Config:
 *   model: string                   (required)
 *   apiKey: string                  (optional; otherwise ANTHROPIC_API_KEY)
 *   apiBase: string                 (optional; for proxies / mocks)
 *   maxTokens: number               (default 4096)
 *   maxTurnRequests: number         (default 16; soft cap on model calls per turn)
 *
 * Translation:
 *   - SessionUpdate `user_message_chunk`  → `{ role: "user", content: [...] }`
 *   - SessionUpdate `agent_message_chunk` → `{ role: "assistant", ... }`
 *   - tool_call / tool_call_update        → tool_use / tool_result blocks
 *
 * The harness keeps requesting the model while the assistant returns
 * tool_use blocks; once it returns a pure text response (no tool_use), the
 * turn ends with `end_turn`.
 */

import type { SessionUpdate, StopReason, ToolCallStatus } from "../../types/acp.js";
import type {
  ExtensionContext,
  Harness,
  HarnessFactory,
  Runtime,
} from "../../types/interfaces.js";

interface AnthropicConfig {
  model?: string;
  apiKey?: string;
  apiBase?: string;
  maxTokens?: number;
  maxTurnRequests?: number;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicResponse {
  id: string;
  role: "assistant";
  content: AnthropicContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | string;
}

export class AnthropicHarness implements Harness {
  constructor(
    private readonly model: string,
    private readonly apiKey: string,
    private readonly apiBase: string,
    private readonly maxTokens: number,
    private readonly maxTurnRequests: number,
  ) {}

  async run(runtime: Runtime): Promise<StopReason> {
    let requests = 0;
    while (true) {
      if (runtime.abortSignal.aborted) {
        await runtime.update({ sessionUpdate: "stop", stopReason: "cancelled" });
        return "cancelled";
      }
      if (requests >= this.maxTurnRequests) {
        await runtime.update({ sessionUpdate: "stop", stopReason: "max_turn_requests" });
        return "max_turn_requests";
      }
      requests += 1;

      const events = await runtime.getEvents();
      const messages = this.eventsToMessages(events);
      const tools = runtime.listTools().map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));

      let response: AnthropicResponse;
      try {
        response = await this.callAPI(runtime.systemPrompt(), messages, tools, runtime.abortSignal);
      } catch (e) {
        await runtime.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `[anthropic error] ${(e as Error).message}` },
        });
        await runtime.update({ sessionUpdate: "stop", stopReason: "error" });
        return "error";
      }

      // Surface the assistant's text + record any tool_use blocks.
      const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
      for (const block of response.content) {
        if (block.type === "text" && block.text) {
          await runtime.update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: block.text },
          });
        } else if (block.type === "tool_use") {
          toolUses.push({ id: block.id, name: block.name, input: block.input });
          await runtime.update({
            sessionUpdate: "tool_call",
            toolCallId: block.id,
            title: block.name,
            status: "in_progress",
            input: block.input,
          });
        }
      }

      if (response.stop_reason === "max_tokens") {
        await runtime.update({ sessionUpdate: "stop", stopReason: "max_tokens" });
        return "max_tokens";
      }

      if (toolUses.length === 0) {
        await runtime.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return "end_turn";
      }

      // Dispatch tools in parallel.
      await Promise.all(
        toolUses.map(async (tu) => {
          const result = await runtime.executeTool({
            id: tu.id,
            name: tu.name,
            input: tu.input,
          });
          const status: ToolCallStatus = result.isError ? "failed" : "completed";
          await runtime.update({
            sessionUpdate: "tool_call_update",
            toolCallId: tu.id,
            status,
            content: [{ type: "content", content: { type: "text", text: result.content } }],
          });
        }),
      );
      // Loop continues; next call will rebuild messages including tool_results.
    }
  }

  private eventsToMessages(events: SessionUpdate[]): AnthropicMessage[] {
    const messages: AnthropicMessage[] = [];
    let current: AnthropicMessage | null = null;
    const pendingToolUseById = new Map<string, { name: string; input: unknown }>();

    const push = (m: AnthropicMessage) => {
      if (current && current.role === m.role) {
        current.content.push(...m.content);
      } else {
        current = m;
        messages.push(current);
      }
    };

    for (const e of events) {
      switch (e.sessionUpdate) {
        case "user_message_chunk": {
          if (e.content.type === "text") {
            push({ role: "user", content: [{ type: "text", text: e.content.text }] });
          }
          break;
        }
        case "agent_message_chunk": {
          if (e.content.type === "text") {
            push({ role: "assistant", content: [{ type: "text", text: e.content.text }] });
          }
          break;
        }
        case "agent_thought_chunk":
          // Thoughts are not sent back to the API in v0.
          break;
        case "tool_call": {
          pendingToolUseById.set(e.toolCallId, { name: e.title, input: e.input });
          push({
            role: "assistant",
            content: [
              { type: "tool_use", id: e.toolCallId, name: e.title, input: e.input ?? {} },
            ],
          });
          break;
        }
        case "tool_call_update": {
          const text =
            (e.content ?? [])
              .map((c) => (c.type === "content" && c.content.type === "text" ? c.content.text : ""))
              .join("") || "";
          push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: e.toolCallId,
                content: text,
                ...(e.status === "failed" ? { is_error: true } : {}),
              },
            ],
          });
          break;
        }
        case "stop":
        case "plan":
          break;
      }
    }
    return messages;
  }

  private async callAPI(
    system: string,
    messages: AnthropicMessage[],
    tools: Array<{ name: string; description: string; input_schema: unknown }>,
    signal: AbortSignal,
  ): Promise<AnthropicResponse> {
    const url = `${this.apiBase.replace(/\/$/, "")}/v1/messages`;
    const body = {
      model: this.model,
      system,
      messages,
      tools,
      max_tokens: this.maxTokens,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${t}`);
    }
    return (await res.json()) as AnthropicResponse;
  }
}

export const anthropicHarnessFactory: HarnessFactory = {
  name: "anthropic",
  create(config: Record<string, unknown>, _ctx: ExtensionContext): Harness {
    const c = config as AnthropicConfig;
    const model = c.model ?? "claude-3-5-sonnet-latest";
    const apiKey = c.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    if (!apiKey) {
      throw new Error(
        "Anthropic harness requires ANTHROPIC_API_KEY env var or [harness].apiKey config",
      );
    }
    const apiBase = c.apiBase ?? "https://api.anthropic.com";
    return new AnthropicHarness(
      model,
      apiKey,
      apiBase,
      c.maxTokens ?? 4096,
      c.maxTurnRequests ?? 16,
    );
  },
};

