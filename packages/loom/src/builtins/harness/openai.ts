import { randomUUID } from "node:crypto";

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
  HarnessModel,
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

  smallModel(): string {
    const m = this.model;
    if (m.includes("mini")) return m;
    if (m.startsWith("o3")) return "o3-mini";
    if (m.startsWith("o1")) return "o1-mini";
    if (m.includes("gpt-4o")) return "gpt-4o-mini";
    if (m.startsWith("gpt-4")) return "gpt-4o-mini";
    return "gpt-4o-mini";
  }

  currentModel(): string {
    return this.model;
  }

  private modelsListCache: HarnessModel[] | null = null;
  private modelsListInflight: Promise<HarnessModel[]> | null = null;

  async models(): Promise<HarnessModel[]> {
    if (this.modelsListCache !== null) return this.modelsListCache;
    if (this.modelsListInflight) return this.modelsListInflight;
    this.modelsListInflight = (async (): Promise<HarnessModel[]> => {
      try {
        const out: HarnessModel[] = [];
        for await (const m of this.client.models.list()) {
          if (!isResponsesApiModel(m.id)) continue;
          out.push({ id: m.id });
        }
        out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        this.modelsListCache = out;
        return out;
      } catch {
        this.modelsListCache = [];
        return [];
      } finally {
        this.modelsListInflight = null;
      }
    })();
    return this.modelsListInflight;
  }

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

  private steerQueue: ACPContentBlock[] = [];

  steer(blocks: ACPContentBlock[]): void {
    this.steerQueue.push(...blocks);
  }

  private async drainSteering(runtime: Runtime): Promise<void> {
    if (this.steerQueue.length === 0) return;
    const blocks = this.steerQueue;
    this.steerQueue = [];
    const messageId = randomUUID();
    await runtime.update({
      sessionUpdate: "frame",
      frame: "message_start",
      role: "user",
      messageId,
    });
    for (const block of blocks) {
      await runtime.update({
        sessionUpdate: "user_message_chunk",
        content: block,
      });
    }
    await runtime.update({
      sessionUpdate: "frame",
      frame: "message_end",
      role: "user",
      messageId,
    });
  }

  async run(runtime: Runtime, params?: RunParameters): Promise<TurnResult> {
    let requests = 0;
    this.turnUsage = null;
    const turnModel = params?.model ?? this.model;
    const turnStream = params?.stream ?? this.stream;
    const turnMaxOutputTokens = params?.maxOutputTokens ?? this.maxOutputTokens;
    const turnReasoning = buildReasoning(params);

    while (true) {
      await this.drainSteering(runtime);
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

      const messageId = randomUUID();
      await runtime.update({
        sessionUpdate: "frame",
        frame: "message_start",
        role: "assistant",
        messageId,
      });
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
        await runtime.update({ sessionUpdate: "stop", stopReason: "error" });
        return this.finishTurn("error", {
          message: `[openai] ${(e as Error).message}`,
        });
      }

      if (response.usage) {
        this.accumulateUsage(response.usage);
        await this.emitUsageUpdate(runtime, response.usage);
      }

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

      // The message_end barrier: the assistant message is complete before any
      // tool from it executes; hosts may rely on this ordering.
      await runtime.update({
        sessionUpdate: "frame",
        frame: "message_end",
        role: "assistant",
        messageId,
      });

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
        const reason = response.incomplete_details?.reason ?? "unknown";
        await runtime.update({ sessionUpdate: "stop", stopReason: "error" });
        return this.finishTurn("error", {
          message: `[openai incomplete] ${reason}`,
        });
      }
      if (response.status === "failed") {
        const message = response.error?.message ?? "unknown";
        await runtime.update({ sessionUpdate: "stop", stopReason: "error" });
        return this.finishTurn("error", {
          message: `[openai failed] ${message}`,
        });
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
          await runtime.emitToolResult({
            toolCallId: tc.call_id,
            status,
            modelContent: result.content,
            ...(result.display ? { display: result.display } : {}),
          });
        }),
      );
    }
  }

  private async runNonStreaming(
    body: ResponseCreateParamsBase,
    runtime: Runtime,
  ): Promise<OpenAIResponse> {
    const response = await this.client.responses.create(
      { ...body, stream: false },
      { signal: runtime.abortSignal },
    );
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

  private finishTurn(
    stopReason: StopReason,
    error?: { message: string },
  ): TurnResult {
    const result: TurnResult = { stopReason };
    if (this.turnUsage) result.usage = this.turnUsage;
    if (error) result.error = error;
    return result;
  }

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

  private eventsToInputItems(events: SessionUpdate[]): ResponseInputItem[] {
    const items: ResponseInputItem[] = [];

    const isMessageItem = (item: ResponseInputItem): item is EasyInputMessage =>
      !("type" in item) || item.type === "message" || item.type === undefined;

    const lastMessageContent = (
      role: "user" | "assistant",
    ): ResponseInputMessageContentList | null => {
      const last = items[items.length - 1];
      if (last && isMessageItem(last) && "role" in last && last.role === role) {
        const easy = last as EasyInputMessage;
        if (Array.isArray(easy.content)) return easy.content;
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
          break;
        case "tool_call": {
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
        case "frame":
          break;
      }
    }
    return items;
  }
}

function isResponsesApiModel(id: string): boolean {
  if (id.startsWith("gpt-")) return true;
  if (id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) {
    return true;
  }
  if (id.startsWith("chatgpt-")) return true;
  return false;
}

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
  // Loom's "max" has no Responses equivalent; "xhigh" is the highest level.
  if (e === "max") return "xhigh";
  return e as ReasoningEffort;
}

function acpToOpenAIContent(
  block: ACPContentBlock,
): ResponseInputContent | null {
  if (block.type === "text") {
    return block.text ? { type: "input_text", text: block.text } : null;
  }
  if (block.type === "image") {
    return {
      type: "input_image",
      detail: "auto",
      image_url: `data:${block.mimeType};base64,${block.data}`,
    };
  }
  if (block.type === "resource") {
    const res = block.resource;
    const text =
      "text" in res && typeof res.text === "string"
        ? res.text
        : `[resource: ${res.uri}]`;
    return { type: "input_text", text };
  }
  return null;
}

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
