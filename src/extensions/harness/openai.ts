/**
 * OpenAI harness — calls the Chat Completions API.
 *
 * Config:
 *   model: string                   (required, e.g. "gpt-4o")
 *   apiKey: string                  (optional; otherwise OPENAI_API_KEY)
 *   apiBase: string                 (optional; default api.openai.com/v1)
 *   maxTokens: number               (optional)
 *   maxTurnRequests: number         (default 16)
 *
 * Translation:
 *   - user_message_chunk    → { role: "user", content: "..." }
 *   - agent_message_chunk   → { role: "assistant", content: "..." }
 *   - tool_call             → { role: "assistant", tool_calls: [...] }
 *   - tool_call_update      → { role: "tool", tool_call_id, content }
 */

import type {
  ExtensionContext,
  Harness,
  HarnessFactory,
  Runtime,
} from "../../types/interfaces.js";
import type { SessionUpdate, StopReason, ToolCallStatus } from "../../types/acp.js";

interface OpenAIConfig {
  model?: string;
  apiKey?: string;
  apiBase?: string;
  maxTokens?: number;
  maxTurnRequests?: number;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAIResponse {
  id: string;
  choices: Array<{
    index: number;
    finish_reason: "stop" | "length" | "tool_calls" | string;
    message: ChatMessage;
  }>;
}

export class OpenAIHarness implements Harness {
  constructor(
    private readonly model: string,
    private readonly apiKey: string,
    private readonly apiBase: string,
    private readonly maxTokens: number | undefined,
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
      const messages: ChatMessage[] = [
        { role: "system", content: runtime.systemPrompt() },
        ...this.eventsToMessages(events),
      ];
      const tools = runtime.listTools().map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));

      let response: OpenAIResponse;
      try {
        response = await this.callAPI(messages, tools, runtime.abortSignal);
      } catch (e) {
        await runtime.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `[openai error] ${(e as Error).message}` },
        });
        await runtime.update({ sessionUpdate: "stop", stopReason: "error" });
        return "error";
      }

      const choice = response.choices[0];
      if (!choice) {
        await runtime.update({ sessionUpdate: "stop", stopReason: "error" });
        return "error";
      }

      const msg = choice.message;
      if (msg.content) {
        await runtime.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: msg.content },
        });
      }

      const toolCalls = msg.tool_calls ?? [];
      for (const tc of toolCalls) {
        let parsedInput: unknown = {};
        try {
          parsedInput = JSON.parse(tc.function.arguments || "{}");
        } catch {
          parsedInput = { _raw: tc.function.arguments };
        }
        await runtime.update({
          sessionUpdate: "tool_call",
          toolCallId: tc.id,
          title: tc.function.name,
          status: "in_progress",
          input: parsedInput,
        });
      }

      if (choice.finish_reason === "length") {
        await runtime.update({ sessionUpdate: "stop", stopReason: "max_tokens" });
        return "max_tokens";
      }

      if (toolCalls.length === 0) {
        await runtime.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return "end_turn";
      }

      await Promise.all(
        toolCalls.map(async (tc) => {
          let parsedInput: unknown = {};
          try {
            parsedInput = JSON.parse(tc.function.arguments || "{}");
          } catch {
            parsedInput = { _raw: tc.function.arguments };
          }
          const result = await runtime.executeTool({
            id: tc.id,
            name: tc.function.name,
            input: parsedInput,
          });
          const status: ToolCallStatus = result.isError ? "failed" : "completed";
          await runtime.update({
            sessionUpdate: "tool_call_update",
            toolCallId: tc.id,
            status,
            content: [{ type: "content", content: { type: "text", text: result.content } }],
          });
        }),
      );
    }
  }

  private eventsToMessages(events: SessionUpdate[]): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const e of events) {
      switch (e.sessionUpdate) {
        case "user_message_chunk":
          if (e.content.type === "text") {
            messages.push({ role: "user", content: e.content.text });
          }
          break;
        case "agent_message_chunk":
          if (e.content.type === "text") {
            messages.push({ role: "assistant", content: e.content.text });
          }
          break;
        case "tool_call": {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: e.toolCallId,
                type: "function",
                function: { name: e.title, arguments: JSON.stringify(e.input ?? {}) },
              },
            ],
          });
          break;
        }
        case "tool_call_update": {
          const text =
            (e.content ?? [])
              .map((c) => (c.type === "content" && c.content.type === "text" ? c.content.text : ""))
              .join("") || "";
          messages.push({ role: "tool", tool_call_id: e.toolCallId, content: text });
          break;
        }
        case "agent_thought_chunk":
        case "stop":
        case "plan":
          break;
      }
    }
    return messages;
  }

  private async callAPI(
    messages: ChatMessage[],
    tools: unknown[],
    signal: AbortSignal,
  ): Promise<OpenAIResponse> {
    const url = `${this.apiBase.replace(/\/$/, "")}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      tools,
    };
    if (this.maxTokens) body.max_tokens = this.maxTokens;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${t}`);
    }
    return (await res.json()) as OpenAIResponse;
  }
}

export const openaiHarnessFactory: HarnessFactory = {
  name: "openai",
  create(config: Record<string, unknown>, _ctx: ExtensionContext): Harness {
    const c = config as OpenAIConfig;
    const model = c.model ?? "gpt-4o-mini";
    const apiKey = c.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    if (!apiKey) {
      throw new Error("OpenAI harness requires OPENAI_API_KEY env var or [harness].apiKey config");
    }
    const apiBase = c.apiBase ?? "https://api.openai.com/v1";
    return new OpenAIHarness(model, apiKey, apiBase, c.maxTokens, c.maxTurnRequests ?? 16);
  },
};
