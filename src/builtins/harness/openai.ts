/**
 * OpenAI harness — Responses API via the official `openai` SDK.
 *
 * Config:
 *   model: string                   (default `gpt-5.1`)
 *   apiKey: string                  (optional; otherwise OPENAI_API_KEY)
 *   apiBase: string                 (optional; default api.openai.com/v1)
 *   maxOutputTokens: number         (optional; soft cap on output + reasoning)
 *   maxTurnRequests: number         (default 16; soft cap on model calls per turn)
 *   stream: boolean                 (default true; emit text + reasoning deltas live)
 *
 * Translation — ACP `SessionUpdate` → Responses API input items:
 *   - `user_message_chunk`   → `EasyInputMessage(role=user)` with mixed text + image content
 *   - `agent_message_chunk`  → `EasyInputMessage(role=assistant)` text
 *   - `agent_thought_chunk`  → dropped (reasoning items are one-way, like Anthropic's thinking)
 *   - `tool_call`            → `ResponseFunctionToolCall` (call_id + name + arguments)
 *   - `tool_call_update`     → `FunctionCallOutput` (call_id + stringified output)
 *
 * Image support flows via ACP's `{ type: "image", mimeType, data }`
 * `ContentBlock`. The harness packs it into a Responses API
 * `input_image` content with a `data:` URL.
 *
 * Reasoning ("thinking"):
 *   - `params.effort` maps to `reasoning.effort` (Responses API
 *     vocabulary: `none | minimal | low | medium | high | xhigh`).
 *     Loom's `"max"` is mapped to `"xhigh"` (the highest level Responses
 *     supports). `"low" | "medium" | "high" | "xhigh"` pass through.
 *   - `params.thinking` is forwarded verbatim as the `reasoning`
 *     param, so callers wanting to set `summary` or other fields can
 *     do so directly.
 *
 * Loop:
 *   The harness re-requests the model while the response contains
 *   `function_call` output items; once it returns text-only output,
 *   the turn ends with `end_turn`. `maxTurnRequests` is a soft cap on
 *   per-turn API requests.
 *
 * Streaming:
 *   With `stream: true` the SDK's `ResponseStream` helper is consumed
 *   via its `response.output_text.delta` and
 *   `response.reasoning_text.delta` events, which emit deltas as they
 *   arrive. The final `Response` is taken from `finalResponse()`.
 */

import OpenAI, { APIUserAbortError } from "openai";
import type {
  EasyInputMessage,
  FunctionTool,
  Response as OpenAIResponse,
  ResponseCreateParamsBase,
  ResponseFunctionToolCall,
  ResponseInputContent,
  ResponseInputItem,
  ResponseInputMessageContentList,
  ResponseOutputItem,
  ResponseUsage,
} from "openai/resources/responses/responses";
import type { Reasoning, ReasoningEffort } from "openai/resources/shared";

import type {
  ContentBlock as ACPContentBlock,
  SessionUpdate,
  StopReason,
  ToolCallStatus,
  TurnUsage,
} from "../../types/acp.js";
import type {
  FactoryContext,
  Harness,
  HarnessFactory,
  RunParameters,
  Runtime,
  SummariseArgs,
  TurnResult,
} from "../../types/interfaces.js";

interface OpenAIConfig {
  model?: string;
  apiBase?: string;
  maxOutputTokens?: number;
  maxTurnRequests?: number;
  stream?: boolean;
}

export class OpenAIHarness implements Harness {
  private readonly client: OpenAI;

  /** Cumulative usage across the current turn. Reset at each `run()` start. */
  private turnUsage: TurnUsage | null = null;

  constructor(
    private readonly model: string,
    private readonly apiKey: string,
    private readonly apiBase: string,
    private readonly maxOutputTokens: number | undefined,
    private readonly maxTurnRequests: number,
    private readonly stream: boolean = true,
  ) {
    this.client = new OpenAI({ apiKey, baseURL: apiBase });
  }

  /**
   * Build a sibling harness with the same credentials/config but a
   * different model id. Mirrors `AnthropicHarness.withModel`; used by
   * parent-derived harness factories.
   */
  withModel(modelId: string): OpenAIHarness {
    return new OpenAIHarness(
      modelId,
      this.apiKey,
      this.apiBase,
      this.maxOutputTokens,
      this.maxTurnRequests,
      this.stream,
    );
  }

  /**
   * Native summarisation. Responses API with no tools and a single
   * combined prompt; cheaper than `summariseViaRun`.
   */
  async summarise(args: SummariseArgs): Promise<string> {
    const input = this.eventsToInputItems(args.events);
    input.push({
      role: "user",
      content: [{ type: "input_text", text: args.instruction }],
    });
    const response = await this.client.responses.create(
      {
        model: this.model,
        instructions: args.systemPrompt,
        input,
      },
      { signal: args.abortSignal },
    );
    return response.output_text ?? extractTextFromOutput(response.output);
  }

  async run(runtime: Runtime, params?: RunParameters): Promise<TurnResult> {
    let requests = 0;
    this.turnUsage = null;
    const turnModel = params?.model ?? this.model;
    const turnStream = params?.stream ?? this.stream;
    const turnMaxOutputTokens = params?.maxOutputTokens ?? this.maxOutputTokens;
    const turnReasoning = buildReasoning(params);

    while (true) {
      if (runtime.abortSignal.aborted) {
        await runtime.update({
          sessionUpdate: "stop",
          stopReason: "cancelled",
        });
        return this.finishTurn("cancelled");
      }
      if (requests >= this.maxTurnRequests) {
        await runtime.update({
          sessionUpdate: "stop",
          stopReason: "max_turn_requests",
        });
        return this.finishTurn("max_turn_requests");
      }
      requests += 1;

      const events = await runtime.getEvents();
      const input = this.eventsToInputItems(events);
      const tools: FunctionTool[] = runtime.listTools().map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as FunctionTool["parameters"],
        strict: false,
      }));

      const body: ResponseCreateParamsBase = {
        model: turnModel,
        instructions: runtime.systemPrompt(),
        input,
        tools,
      };
      if (turnMaxOutputTokens !== undefined) {
        body.max_output_tokens = turnMaxOutputTokens;
      }
      if (turnReasoning) {
        body.reasoning = turnReasoning;
      }

      let response: OpenAIResponse;
      try {
        response = turnStream
          ? await this.runStreaming(body, runtime)
          : await this.runNonStreaming(body, runtime);
      } catch (e) {
        if (e instanceof APIUserAbortError) {
          await runtime.update({
            sessionUpdate: "stop",
            stopReason: "cancelled",
          });
          return this.finishTurn("cancelled");
        }
        await runtime.update({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `[openai error] ${(e as Error).message}`,
          },
        });
        await runtime.update({ sessionUpdate: "stop", stopReason: "error" });
        return this.finishTurn("error");
      }

      if (response.usage) {
        this.accumulateUsage(response.usage);
        await this.emitUsageUpdate(runtime, response.usage);
      }

      // Walk the output items: collect function calls for dispatch.
      const toolCalls: ResponseFunctionToolCall[] = [];
      for (const item of response.output) {
        if (item.type === "function_call") {
          toolCalls.push(item);
          let parsedInput: unknown = {};
          try {
            parsedInput = item.arguments ? JSON.parse(item.arguments) : {};
          } catch {
            parsedInput = { _rawArgs: item.arguments };
          }
          await runtime.update({
            sessionUpdate: "tool_call",
            toolCallId: item.call_id,
            title: item.name,
            status: "in_progress",
            rawInput: parsedInput,
          });
        }
      }

      // Map Responses API stop conditions to ACP `StopReason`. The
      // Responses API uses `incomplete_details.reason` when the response
      // didn't finish naturally; the `status` field carries the broad
      // outcome.
      if (
        response.status === "incomplete" &&
        response.incomplete_details?.reason === "max_output_tokens"
      ) {
        await runtime.update({
          sessionUpdate: "stop",
          stopReason: "max_tokens",
        });
        return this.finishTurn("max_tokens");
      }
      if (response.status === "incomplete") {
        // Other incomplete reasons (content_filter, etc.) — surface as error.
        await runtime.update({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `[openai incomplete] ${response.incomplete_details?.reason ?? "unknown"}`,
          },
        });
        await runtime.update({ sessionUpdate: "stop", stopReason: "error" });
        return this.finishTurn("error");
      }
      if (response.status === "failed") {
        await runtime.update({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `[openai failed] ${response.error?.message ?? "unknown"}`,
          },
        });
        await runtime.update({ sessionUpdate: "stop", stopReason: "error" });
        return this.finishTurn("error");
      }

      if (toolCalls.length === 0) {
        await runtime.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return this.finishTurn("end_turn");
      }

      await Promise.all(
        toolCalls.map(async (tc) => {
          let parsedInput: unknown = {};
          try {
            parsedInput = tc.arguments ? JSON.parse(tc.arguments) : {};
          } catch {
            parsedInput = { _rawArgs: tc.arguments };
          }
          const result = await runtime.executeTool({
            id: tc.call_id,
            name: tc.name,
            input: parsedInput,
          });
          const status: ToolCallStatus = result.isError
            ? "failed"
            : "completed";
          await runtime.update({
            sessionUpdate: "tool_call_update",
            toolCallId: tc.call_id,
            status,
            content: [
              {
                type: "content",
                content: { type: "text", text: result.content },
              },
            ],
          });
        }),
      );
      // Next iteration: input items include the function_call and
      // function_call_output records for these calls.
    }
  }

  /** Non-streaming path: one `responses.create()` call. */
  private async runNonStreaming(
    body: ResponseCreateParamsBase,
    runtime: Runtime,
  ): Promise<OpenAIResponse> {
    const response = await this.client.responses.create(
      { ...body, stream: false },
      { signal: runtime.abortSignal },
    );
    // Surface text + reasoning content blocks (no live streaming).
    for (const item of response.output) {
      if (item.type === "message" && item.role === "assistant") {
        for (const part of item.content) {
          if (part.type === "output_text" && part.text) {
            await runtime.update({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: part.text },
            });
          } else if (part.type === "refusal") {
            await runtime.update({
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `[refusal] ${part.refusal}`,
              },
            });
          }
        }
      } else if (item.type === "reasoning") {
        for (const part of item.content ?? []) {
          if (part.text) {
            await runtime.update({
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: part.text },
            });
          }
        }
        for (const part of item.summary) {
          if (part.text) {
            await runtime.update({
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: part.text },
            });
          }
        }
      }
    }
    return response;
  }

  /**
   * Streaming path: forward text + reasoning text deltas live via the
   * SDK's `ResponseStream` helper. Final `Response` from
   * `finalResponse()` is returned to the common post-response code.
   */
  private async runStreaming(
    body: ResponseCreateParamsBase,
    runtime: Runtime,
  ): Promise<OpenAIResponse> {
    const stream = this.client.responses.stream(
      { ...body, stream: true },
      { signal: runtime.abortSignal },
    );

    let emitChain: Promise<void> = Promise.resolve();
    const enqueue = (update: SessionUpdate): void => {
      emitChain = emitChain.then(() => runtime.update(update));
    };
    stream.on("response.output_text.delta", (event) => {
      if (event.delta) {
        enqueue({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: event.delta },
        });
      }
    });
    stream.on("response.reasoning_text.delta", (event) => {
      if (event.delta) {
        enqueue({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: event.delta },
        });
      }
    });
    stream.on("response.refusal.delta", (event) => {
      if (event.delta) {
        enqueue({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: event.delta },
        });
      }
    });
    const final = await stream.finalResponse();
    await emitChain;
    return final;
  }

  /** Wrap a stop reason with the turn's accumulated usage (if any). */
  private finishTurn(stopReason: StopReason): TurnResult {
    return this.turnUsage
      ? { stopReason, usage: this.turnUsage }
      : { stopReason };
  }

  /** Fold a per-request usage payload into the turn's cumulative tally. */
  private accumulateUsage(u: ResponseUsage): void {
    const cur: TurnUsage = this.turnUsage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    cur.inputTokens += u.input_tokens;
    cur.outputTokens += u.output_tokens;
    if (u.input_tokens_details?.cached_tokens) {
      cur.cachedReadTokens =
        (cur.cachedReadTokens ?? 0) + u.input_tokens_details.cached_tokens;
    }
    if (u.output_tokens_details?.reasoning_tokens) {
      cur.thoughtTokens =
        (cur.thoughtTokens ?? 0) + u.output_tokens_details.reasoning_tokens;
    }
    cur.totalTokens =
      cur.inputTokens +
      cur.outputTokens +
      (cur.thoughtTokens ?? 0) +
      (cur.cachedReadTokens ?? 0) +
      (cur.cachedWriteTokens ?? 0);
    this.turnUsage = cur;
  }

  /**
   * Emit a `usage_update`. `used` = this request's input + output; the
   * Responses API doesn't surface a context window from its standard
   * usage payload, so `size` is left at 0 (clients render "used"
   * alone). A model-info lookup is possible via `client.models.retrieve`
   * but the field isn't standardised; we defer that until OpenAI
   * exposes it consistently.
   */
  private async emitUsageUpdate(
    runtime: Runtime,
    u: ResponseUsage,
  ): Promise<void> {
    const used = u.input_tokens + u.output_tokens;
    await runtime.update({
      sessionUpdate: "usage_update",
      used,
      size: 0,
    });
  }

  /**
   * Translate the session event log into Responses API input items.
   * Consecutive user/assistant text chunks coalesce into one message
   * (matching natural turn boundaries). Image content packs into an
   * `input_image` content part with a base64 `data:` URL.
   *
   * Function calls and their results round-trip as discrete input
   * items (`function_call` + `function_call_output`) so the model can
   * correlate them across turns.
   */
  private eventsToInputItems(events: SessionUpdate[]): ResponseInputItem[] {
    const items: ResponseInputItem[] = [];

    /**
     * If the last item is a user/assistant message, return its content
     * list (creating array form if it's currently a plain string).
     * Otherwise null — the caller pushes a fresh message.
     */
    const lastMessageContent = (
      role: "user" | "assistant",
    ): ResponseInputMessageContentList | null => {
      const last = items[items.length - 1];
      if (
        last &&
        !(
          "type" in last &&
          last.type !== "message" &&
          last.type !== undefined
        ) &&
        "role" in last &&
        last.role === role &&
        (!("type" in last) ||
          last.type === "message" ||
          last.type === undefined)
      ) {
        const easy = last as EasyInputMessage;
        if (Array.isArray(easy.content)) return easy.content;
        // String shorthand — promote to array form.
        const promoted: ResponseInputMessageContentList = easy.content
          ? [{ type: "input_text", text: easy.content }]
          : [];
        easy.content = promoted;
        return promoted;
      }
      return null;
    };

    const pushUserContent = (part: ResponseInputContent): void => {
      const existing = lastMessageContent("user");
      if (existing) {
        existing.push(part);
      } else {
        items.push({ role: "user", content: [part] });
      }
    };
    const pushAssistantText = (text: string): void => {
      const existing = lastMessageContent("assistant");
      if (existing) {
        // Assistant input messages use `input_text` for content parts
        // (echoing the conversation back to the model).
        existing.push({ type: "input_text", text });
      } else {
        items.push({
          role: "assistant",
          content: [{ type: "input_text", text }],
        });
      }
    };

    for (const e of events) {
      switch (e.sessionUpdate) {
        case "user_message_chunk": {
          const part = acpToOpenAIContent(e.content);
          if (part) pushUserContent(part);
          break;
        }
        case "agent_message_chunk": {
          if (e.content.type === "text" && e.content.text) {
            pushAssistantText(e.content.text);
          }
          break;
        }
        case "agent_thought_chunk":
          // Reasoning is one-way; don't echo it back.
          break;
        case "tool_call": {
          // Emit a function_call output item so the model sees its
          // own prior tool invocation when correlating against
          // function_call_output below.
          const call: ResponseFunctionToolCall = {
            type: "function_call",
            call_id: e.toolCallId,
            name: e.title,
            arguments: JSON.stringify(e.rawInput ?? {}),
          };
          items.push(call);
          break;
        }
        case "tool_call_update": {
          const text =
            (e.content ?? [])
              .map((c) =>
                c.type === "content" && c.content.type === "text"
                  ? c.content.text
                  : "",
              )
              .join("") || "";
          items.push({
            type: "function_call_output",
            call_id: e.toolCallId,
            output: text,
          });
          break;
        }
        case "stop":
        case "plan":
        case "usage_update":
          break;
      }
    }
    return items;
  }
}

/**
 * Build the `reasoning` body field from RunParameters. Returns
 * undefined when no reasoning config is requested (skips the field
 * entirely so non-reasoning models don't reject the request).
 *
 * `params.thinking` (when set) wins, since callers passing it expect
 * to control the full `Reasoning` shape (effort + summary). When only
 * `params.effort` is set, we map it to `reasoning.effort`. Loom's
 * `"max"` is an Anthropic-only level; on OpenAI it maps to `"xhigh"`.
 */
function buildReasoning(
  params: RunParameters | undefined,
): Reasoning | undefined {
  if (params?.thinking !== undefined) {
    return params.thinking as Reasoning;
  }
  if (params?.effort) {
    return { effort: mapEffort(params.effort) };
  }
  return undefined;
}

function mapEffort(e: RunParameters["effort"]): ReasoningEffort {
  // Responses API supports: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  // Loom's RunParameters: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  if (e === "max") return "xhigh";
  return e as ReasoningEffort;
}

/** Translate an ACP ContentBlock to a Responses API input content part. */
function acpToOpenAIContent(
  block: ACPContentBlock,
): ResponseInputContent | null {
  if (block.type === "text") {
    return block.text ? { type: "input_text", text: block.text } : null;
  }
  if (block.type === "image") {
    // Responses API accepts either a `file_id` (uploaded via /files)
    // or an `image_url` that may be a fully-qualified URL OR a base64
    // data URL. ACP carries the bytes, so we use the data URL form.
    return {
      type: "input_image",
      detail: "auto",
      image_url: `data:${block.mimeType};base64,${block.data}`,
    };
  }
  if (block.type === "resource") {
    // Resource blocks aren't a thing on OpenAI; degrade to text.
    const res = block.resource;
    const text =
      "text" in res && typeof res.text === "string"
        ? res.text
        : `[resource: ${res.uri}]`;
    return { type: "input_text", text };
  }
  return null;
}

/** Fallback text extractor for `summarise()` when `output_text` isn't populated. */
function extractTextFromOutput(items: ResponseOutputItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === "message" && item.role === "assistant") {
      for (const c of item.content) {
        if (c.type === "output_text" && c.text) parts.push(c.text);
      }
    }
  }
  return parts.join("");
}

export const openaiHarnessFactory: HarnessFactory = {
  name: "openai",
  secrets: { required: ["OPENAI_API_KEY"] },
  // OpenAI Responses API accepts inline image content and embedded
  // resources. Audio isn't supported in this path. Reported at
  // `initialize` time without instantiating the harness.
  acpCapabilities() {
    return { promptCapabilities: { image: true, embeddedContext: true } };
  },
  create(
    config: Record<string, unknown>,
    _ctx: FactoryContext,
    secrets: Record<string, string>,
  ): Harness {
    const c = config as OpenAIConfig;
    const apiKey = secrets.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OpenAI harness was instantiated without OPENAI_API_KEY in its secrets bundle",
      );
    }
    return new OpenAIHarness(
      c.model ?? "gpt-5.1",
      apiKey,
      c.apiBase ?? "https://api.openai.com/v1",
      c.maxOutputTokens,
      c.maxTurnRequests ?? 16,
      c.stream ?? true,
    );
  },
};
