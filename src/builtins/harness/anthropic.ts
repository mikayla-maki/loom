import Anthropic, { APIUserAbortError } from "@anthropic-ai/sdk";
import type {
  ContentBlock as AnthropicContentBlock,
  ContentBlockParam,
  Message as AnthropicMessage,
  MessageCreateParamsBase,
  MessageParam,
  Tool as AnthropicTool,
  ToolUnion as AnthropicToolUnion,
  Usage as AnthropicUsage,
  WebFetchTool20250910,
  WebFetchToolResultBlock,
  WebSearchTool20250305,
  WebSearchToolResultBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type { ModelInfo } from "@anthropic-ai/sdk/resources/models";

import type {
  ContentBlock as ACPContentBlock,
  SessionUpdate,
  StopReason,
  ToolCallStatus,
  TurnUsage,
} from "../../types/acp.js";
import type {
  Agent,
  FactoryContext,
  Harness,
  HarnessFactory,
  HarnessModel,
  RunParameters,
  Runtime,
  SummariseArgs,
  Tool,
  ToolConfig,
  ToolResult,
  TurnResult,
} from "../../types/interfaces.js";
import type { CapabilitySet } from "../../types/manifest.js";
import type { JSONSchema } from "../../types/schema.js";

interface AnthropicConfig {
  model?: string;
  apiBase?: string;
  maxTokens?: number;
  maxTurnRequests?: number;
  stream?: boolean;
}

interface ServerToolSpec {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  capabilityKinds: string[];
  toApiTool(
    config: ToolConfig,
    capabilities: CapabilitySet | undefined,
  ): AnthropicToolUnion;
}

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((s): s is string => typeof s === "string");
  return arr.length > 0 ? arr : undefined;
}

function allowedDomainsCapability(
  capabilities: CapabilitySet | undefined,
): string[] | undefined {
  if (!capabilities || capabilities === "*") return undefined;
  const raw = (capabilities as Record<string, unknown>).allowed_domains;
  if (raw === "*") return undefined;
  return stringArray(raw);
}

const SERVER_TOOLS: Record<string, ServerToolSpec> = {
  web_search: {
    name: "web_search",
    description:
      "Search the web. Anthropic runs the search server-side and " +
      "returns results in the same response — no client-side dispatch. " +
      "Useful for grounding answers in recent information.",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "Natural-language search query.",
        },
      },
    },
    capabilityKinds: ["allowed_domains"],
    toApiTool(
      config: ToolConfig,
      capabilities: CapabilitySet | undefined,
    ): WebSearchTool20250305 {
      const out: WebSearchTool20250305 = {
        type: "web_search_20250305",
        name: "web_search",
      };
      if (typeof config.max_uses === "number") out.max_uses = config.max_uses;
      const allowed = allowedDomainsCapability(capabilities);
      if (allowed) out.allowed_domains = allowed;
      const blocked = stringArray(config.blocked_domains);
      if (blocked) out.blocked_domains = blocked;
      if (
        config.user_location !== undefined &&
        config.user_location !== null &&
        typeof config.user_location === "object"
      ) {
        out.user_location =
          config.user_location as WebSearchTool20250305["user_location"];
      }
      return out;
    },
  },
  web_fetch: {
    name: "web_fetch",
    description:
      "Fetch the contents of a specific URL. Anthropic retrieves " +
      "the page server-side and returns the extracted text (or PDF) " +
      "in the same response. Useful when you already know the URL " +
      "and want full content rather than a search summary.",
    inputSchema: {
      type: "object",
      required: ["url"],
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          minLength: 1,
          description: "Absolute URL to fetch (http or https).",
        },
      },
    },
    capabilityKinds: ["allowed_domains"],
    toApiTool(
      config: ToolConfig,
      capabilities: CapabilitySet | undefined,
    ): WebFetchTool20250910 {
      const out: WebFetchTool20250910 = {
        type: "web_fetch_20250910",
        name: "web_fetch",
      };
      if (typeof config.max_uses === "number") out.max_uses = config.max_uses;
      if (typeof config.max_content_tokens === "number") {
        out.max_content_tokens = config.max_content_tokens;
      }
      const allowed = allowedDomainsCapability(capabilities);
      if (allowed) out.allowed_domains = allowed;
      const blocked = stringArray(config.blocked_domains);
      if (blocked) out.blocked_domains = blocked;
      if (
        config.citations !== undefined &&
        config.citations !== null &&
        typeof config.citations === "object"
      ) {
        out.citations = config.citations as WebFetchTool20250910["citations"];
      }
      return out;
    },
  },
};

class AnthropicServerToolStub implements Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly capabilities: CapabilitySet | undefined;
  readonly optional: string[];
  constructor(spec: ServerToolSpec, capabilities: CapabilitySet | undefined) {
    this.name = spec.name;
    this.description = spec.description;
    this.inputSchema = spec.inputSchema;
    this.capabilities = capabilities;
    this.optional = [...spec.capabilityKinds];
  }
  async execute(): Promise<ToolResult> {
    return {
      content:
        `[anthropic] '${this.name}' is a server-side tool dispatched by ` +
        `the harness; it shouldn't have been routed through ToolTable. ` +
        `This is a runtime bug.`,
      isError: true,
    };
  }
}

const ANTHROPIC_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

type AnthropicImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

function isAnthropicImageMediaType(s: string): s is AnthropicImageMediaType {
  return ANTHROPIC_IMAGE_MIME_TYPES.has(s);
}

export class AnthropicHarness implements Harness {
  private readonly client: Anthropic;

  private modelInfoCache = new Map<string, ModelInfo | null>();
  private modelInfoInflight = new Map<string, Promise<ModelInfo | null>>();

  private turnUsage: TurnUsage | null = null;

  private serverToolConfigs = new Map<string, ToolConfig>();

  private serverToolCapabilities = new Map<string, CapabilitySet | undefined>();

  constructor(
    private readonly model: string,
    private readonly apiKey: string,
    private readonly apiBase: string,
    private readonly maxTokens: number,
    private readonly maxTurnRequests: number,
    private readonly stream: boolean = true,
  ) {
    this.client = new Anthropic({ apiKey, baseURL: apiBase });
  }

  availableTools(): { name: string; config: ToolConfig }[] {
    return Object.values(SERVER_TOOLS).map((s) => ({
      name: s.name,
      config: {},
    }));
  }

  resolveTool(
    name: string,
    config: ToolConfig,
    _agent: Agent,
    capabilities: CapabilitySet | undefined,
  ): Tool | null {
    const spec = SERVER_TOOLS[name];
    if (!spec) return null;
    this.serverToolConfigs.set(name, config);
    this.serverToolCapabilities.set(name, capabilities);
    return new AnthropicServerToolStub(spec, capabilities);
  }

  withModel(modelId: string): AnthropicHarness {
    return new AnthropicHarness(
      modelId,
      this.apiKey,
      this.apiBase,
      this.maxTokens,
      this.maxTurnRequests,
      this.stream,
    );
  }

  smallModel(): string {
    const m = this.model;
    if (m.includes("haiku")) return m;
    if (m.includes("sonnet")) return m.replace("sonnet", "haiku");
    if (m.includes("opus")) return m.replace("opus", "haiku");
    return "claude-haiku-4-5";
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
          out.push({
            id: m.id,
            ...(m.display_name ? { name: m.display_name } : {}),
          });
        }
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
    const messages = this.eventsToMessages(args.events);
    messages.push({
      role: "user",
      content: [{ type: "text", text: args.instruction }],
    });
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        system: args.systemPrompt,
        messages,
        // Reuse the cached conversation prefix written during run().
        cache_control: { type: "ephemeral" },
      },
      { signal: args.abortSignal },
    );
    return response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
  }

  async run(runtime: Runtime, params?: RunParameters): Promise<TurnResult> {
    let requests = 0;
    this.turnUsage = null;
    const turnModel = params?.model ?? this.model;
    const turnStream = params?.stream ?? this.stream;
    const turnMaxTokens = params?.maxOutputTokens ?? this.maxTokens;
    const turnEffort = params?.effort;
    const turnThinking = params?.thinking;

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
      const messages = this.eventsToMessages(events);
      const tools: AnthropicToolUnion[] = runtime.listTools().map((t) => {
        const serverSpec = SERVER_TOOLS[t.name];
        if (serverSpec) {
          const cfg = this.serverToolConfigs.get(t.name) ?? {};
          const caps = this.serverToolCapabilities.get(t.name);
          return serverSpec.toApiTool(cfg, caps);
        }
        const userTool: AnthropicTool = {
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as AnthropicTool["input_schema"],
        };
        return userTool;
      });

      const body: MessageCreateParamsBase = {
        model: turnModel,
        max_tokens: turnMaxTokens,
        system: runtime.systemPrompt(),
        messages,
        tools,
        // Automatic prompt caching: a single top-level breakpoint that the
        // API applies to the last cacheable block and advances as the
        // conversation grows. Each request caches the full prefix (tools +
        // system + prior messages) and reads it back on the next request —
        // no manual per-block breakpoint bookkeeping. Without this, none of
        // the request is cached and every turn re-bills the entire prompt.
        cache_control: { type: "ephemeral" },
      };
      if (turnThinking !== undefined) {
        body.thinking = turnThinking as MessageCreateParamsBase["thinking"];
      }
      if (turnEffort) {
        body.output_config = { effort: turnEffort };
      }

      let response: AnthropicMessage;
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
          message: `[anthropic] ${(e as Error).message}`,
        });
      }

      if (response.usage) {
        this.accumulateUsage(response.usage);
        await this.emitUsageUpdate(
          runtime,
          response.usage,
          response.model ?? turnModel,
        );
      }

      const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          toolUses.push({
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }

      if (response.stop_reason === "max_tokens") {
        await runtime.update({
          sessionUpdate: "stop",
          stopReason: "max_tokens",
        });
        return this.finishTurn("max_tokens");
      }

      if (response.stop_reason === "refusal") {
        await runtime.update({
          sessionUpdate: "stop",
          stopReason: "refusal",
        });
        return this.finishTurn("refusal");
      }

      if (toolUses.length === 0) {
        await runtime.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return this.finishTurn("end_turn");
      }

      await Promise.all(
        toolUses.map(async (tu) => {
          const result = await runtime.executeTool({
            id: tu.id,
            name: tu.name,
            input: tu.input,
          });
          const status: ToolCallStatus = result.isError
            ? "failed"
            : "completed";
          await runtime.emitToolResult({
            toolCallId: tu.id,
            status,
            modelContent: result.content,
            ...(result.display ? { display: result.display } : {}),
          });
        }),
      );
    }
  }

  private async emitServerToolResult(
    runtime: Runtime,
    block: WebSearchToolResultBlock | WebFetchToolResultBlock,
    serverToolUses: Map<string, { name: string; input: unknown }>,
  ): Promise<void> {
    const pair = serverToolUses.get(block.tool_use_id);
    const { text, isError } =
      block.type === "web_search_tool_result"
        ? renderWebSearchResult(block)
        : renderWebFetchResult(block);
    const name =
      pair?.name ??
      (block.type === "web_search_tool_result" ? "web_search" : "web_fetch");
    await runtime.emitToolResult({
      toolCallId: block.tool_use_id,
      status: isError ? "failed" : "completed",
      modelContent: text,
      display: {
        title: name,
        kind: "fetch",
        rawOutput: block,
      },
    });
  }

  private async runNonStreaming(
    body: MessageCreateParamsBase,
    runtime: Runtime,
  ): Promise<AnthropicMessage> {
    const response = await this.client.messages.create(
      { ...body, stream: false },
      { signal: runtime.abortSignal },
    );
    const serverToolUses = new Map<string, { name: string; input: unknown }>();
    for (const block of response.content) {
      await this.emitContentBlockInline(runtime, block, serverToolUses);
    }
    return response;
  }

  private async runStreaming(
    body: MessageCreateParamsBase,
    runtime: Runtime,
  ): Promise<AnthropicMessage> {
    const stream = this.client.messages.stream(
      { ...body, stream: true },
      { signal: runtime.abortSignal },
    );
    // Chain emissions onto one promise to preserve SDK event arrival order.
    const serverToolUses = new Map<string, { name: string; input: unknown }>();
    let emitChain: Promise<void> = Promise.resolve();
    const enqueue = (action: () => Promise<void>): void => {
      emitChain = emitChain.then(action).catch(() => undefined);
    };
    stream.on("text", (delta) => {
      if (delta) {
        enqueue(() =>
          runtime.update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: delta },
          }),
        );
      }
    });
    stream.on("thinking", (delta) => {
      if (delta) {
        enqueue(() =>
          runtime.update({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: delta },
          }),
        );
      }
    });
    stream.on("contentBlock", (block) => {
      if (block.type === "text" || block.type === "thinking") return;
      enqueue(() =>
        this.emitContentBlockInline(runtime, block, serverToolUses),
      );
    });
    const final = await stream.finalMessage();
    await emitChain; // flush queued events before returning
    return final;
  }

  private async emitContentBlockInline(
    runtime: Runtime,
    block: AnthropicContentBlock,
    serverToolUses: Map<string, { name: string; input: unknown }>,
  ): Promise<void> {
    switch (block.type) {
      case "text":
        if (block.text) {
          await runtime.update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: block.text },
          });
        }
        return;
      case "thinking":
        if (block.thinking) {
          await runtime.update({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: block.thinking },
          });
        }
        return;
      case "tool_use":
        await runtime.update({
          sessionUpdate: "tool_call",
          toolCallId: block.id,
          title: block.name,
          status: "in_progress",
          rawInput: block.input,
        });
        return;
      case "server_tool_use":
        serverToolUses.set(block.id, {
          name: block.name,
          input: block.input,
        });
        await runtime.update({
          sessionUpdate: "tool_call",
          toolCallId: block.id,
          title: block.name,
          status: "in_progress",
          rawInput: block.input,
        });
        return;
      case "web_search_tool_result":
      case "web_fetch_tool_result":
        await this.emitServerToolResult(runtime, block, serverToolUses);
        return;
      default:
        return;
    }
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

  private accumulateUsage(u: AnthropicUsage): void {
    const cur: TurnUsage = this.turnUsage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    cur.inputTokens += u.input_tokens;
    cur.outputTokens += u.output_tokens;
    if (
      u.cache_read_input_tokens !== null &&
      u.cache_read_input_tokens !== undefined
    ) {
      cur.cachedReadTokens =
        (cur.cachedReadTokens ?? 0) + u.cache_read_input_tokens;
    }
    if (
      u.cache_creation_input_tokens !== null &&
      u.cache_creation_input_tokens !== undefined
    ) {
      cur.cachedWriteTokens =
        (cur.cachedWriteTokens ?? 0) + u.cache_creation_input_tokens;
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
    u: AnthropicUsage,
    modelId: string,
  ): Promise<void> {
    const used = u.input_tokens + u.output_tokens;
    const info = await this.fetchModelInfo(modelId, runtime.abortSignal);
    const size = info?.max_input_tokens ?? 0;
    await runtime.update({
      sessionUpdate: "usage_update",
      used,
      size,
    });
  }

  private async fetchModelInfo(
    modelId: string,
    signal: AbortSignal,
  ): Promise<ModelInfo | null> {
    if (this.modelInfoCache.has(modelId)) {
      return this.modelInfoCache.get(modelId) ?? null;
    }
    const inflight = this.modelInfoInflight.get(modelId);
    if (inflight) return await inflight;

    const promise = (async (): Promise<ModelInfo | null> => {
      try {
        return await this.client.models.retrieve(modelId, null, { signal });
      } catch {
        return null;
      }
    })();
    this.modelInfoInflight.set(modelId, promise);
    const result = await promise;
    this.modelInfoInflight.delete(modelId);
    this.modelInfoCache.set(modelId, result);
    return result;
  }

  private eventsToMessages(events: SessionUpdate[]): MessageParam[] {
    const messages: MessageParam[] = [];

    const push = (m: MessageParam): void => {
      const last = messages[messages.length - 1];
      if (last && last.role === m.role) {
        const lastContent = Array.isArray(last.content)
          ? last.content
          : [{ type: "text" as const, text: last.content }];
        const incoming = Array.isArray(m.content)
          ? m.content
          : [{ type: "text" as const, text: m.content }];
        last.content = [...lastContent, ...incoming];
      } else {
        messages.push(m);
      }
    };

    // Pre-pass: a server tool replays as a server_tool_use + *_tool_result
    // pair on the assistant message, so its `tool_call_update` is skipped
    // below — sending it as a user tool_result would collide with the
    // server-tool declaration in the request `tools` array.
    const serverPayloads = new Map<
      string,
      {
        name: string;
        input: unknown;
        rawOutput?: WebSearchToolResultBlock | WebFetchToolResultBlock;
      }
    >();
    for (const e of events) {
      if (e.sessionUpdate === "tool_call" && e.title in SERVER_TOOLS) {
        serverPayloads.set(e.toolCallId, {
          name: e.title,
          input: e.rawInput,
        });
      } else if (
        e.sessionUpdate === "tool_call_update" &&
        serverPayloads.has(e.toolCallId)
      ) {
        const slot = serverPayloads.get(e.toolCallId);
        if (!slot) continue;
        const raw = (e as { rawOutput?: unknown }).rawOutput;
        if (isServerToolResultBlock(raw)) slot.rawOutput = raw;
      }
    }

    for (const e of events) {
      switch (e.sessionUpdate) {
        case "user_message_chunk": {
          const block = acpToAnthropicContent(e.content);
          if (block) push({ role: "user", content: [block] });
          break;
        }
        case "agent_message_chunk": {
          if (e.content.type === "text" && e.content.text) {
            push({
              role: "assistant",
              content: [{ type: "text", text: e.content.text }],
            });
          }
          break;
        }
        case "agent_thought_chunk":
          break;
        case "tool_call": {
          const server = serverPayloads.get(e.toolCallId);
          if (server) {
            push({
              role: "assistant",
              content: serverToolPairAsParams(
                e.toolCallId,
                e.title,
                e.rawInput,
                server.rawOutput,
              ),
            });
            break;
          }
          push({
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: e.toolCallId,
                name: e.title,
                input: (e.rawInput as Record<string, unknown>) ?? {},
              },
            ],
          });
          break;
        }
        case "tool_call_update": {
          if (serverPayloads.has(e.toolCallId)) break;
          const text =
            (e.content ?? [])
              .map((c) =>
                c.type === "content" && c.content.type === "text"
                  ? c.content.text
                  : "",
              )
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
        case "usage_update":
          break;
      }
    }
    return messages;
  }
}

function isServerToolResultBlock(
  v: unknown,
): v is WebSearchToolResultBlock | WebFetchToolResultBlock {
  if (typeof v !== "object" || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return t === "web_search_tool_result" || t === "web_fetch_tool_result";
}

function serverToolPairAsParams(
  toolCallId: string,
  toolName: string,
  input: unknown,
  result: WebSearchToolResultBlock | WebFetchToolResultBlock | undefined,
): ContentBlockParam[] {
  const useBlock: ContentBlockParam = {
    type: "server_tool_use",
    id: toolCallId,
    name: toolName as "web_search" | "web_fetch",
    input: (input as Record<string, unknown>) ?? {},
  };
  if (result) {
    return [useBlock, result as unknown as ContentBlockParam];
  }
  return [useBlock, placeholderUnavailableResult(toolCallId, toolName)];
}

function placeholderUnavailableResult(
  toolCallId: string,
  toolName: string,
): ContentBlockParam {
  if (toolName === "web_fetch") {
    return {
      type: "web_fetch_tool_result",
      tool_use_id: toolCallId,
      content: {
        type: "web_fetch_tool_result_error",
        error_code: "unavailable",
      },
    };
  }
  return {
    type: "web_search_tool_result",
    tool_use_id: toolCallId,
    content: {
      type: "web_search_tool_result_error",
      error_code: "unavailable",
    },
  };
}

function renderWebSearchResult(block: WebSearchToolResultBlock): {
  text: string;
  isError: boolean;
} {
  const c = block.content;
  if (!Array.isArray(c)) {
    return {
      text: `[web_search error: ${c.error_code}]`,
      isError: true,
    };
  }
  if (c.length === 0) {
    return { text: "[web_search returned no results]", isError: false };
  }
  const lines: string[] = ["# Web search results", ""];
  for (const r of c) {
    lines.push(`## ${r.title}`);
    lines.push(r.url);
    if (r.page_age) lines.push(`(${r.page_age})`);
    lines.push("");
  }
  return { text: lines.join("\n").trimEnd(), isError: false };
}

function renderWebFetchResult(block: WebFetchToolResultBlock): {
  text: string;
  isError: boolean;
} {
  const c = block.content;
  if (c.type === "web_fetch_tool_result_error") {
    return {
      text: `[web_fetch error: ${c.error_code}]`,
      isError: true,
    };
  }
  const lines: string[] = [];
  const title = c.content.title ?? c.url;
  lines.push(`# ${title}`);
  lines.push(c.url);
  if (c.retrieved_at) lines.push(`(retrieved ${c.retrieved_at})`);
  lines.push("");
  const src = c.content.source;
  if (src.type === "text") {
    lines.push(src.data);
  } else {
    lines.push(`[PDF content; ${src.media_type}; see rawOutput for bytes]`);
  }
  return { text: lines.join("\n").trimEnd(), isError: false };
}

function acpToAnthropicContent(
  block: ACPContentBlock,
): ContentBlockParam | null {
  if (block.type === "text") {
    return block.text ? { type: "text", text: block.text } : null;
  }
  if (block.type === "image") {
    if (!isAnthropicImageMediaType(block.mimeType)) {
      return {
        type: "text",
        text: `[unsupported image type: ${block.mimeType}]`,
      };
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: block.mimeType,
        data: block.data,
      },
    };
  }
  if (block.type === "resource") {
    const res = block.resource;
    const text =
      "text" in res && typeof res.text === "string"
        ? res.text
        : `[resource: ${res.uri}]`;
    return { type: "text", text };
  }
  return null;
}

// Re-exported for `parent-derived.ts`; not part of the public SDK surface.
export type { AnthropicContentBlock };

export const anthropicHarnessFactory: HarnessFactory = {
  name: "anthropic",
  secrets: { required: ["ANTHROPIC_API_KEY"] },
  acpCapabilities() {
    return { promptCapabilities: { image: true, embeddedContext: true } };
  },
  create(
    config: Record<string, unknown>,
    _ctx: FactoryContext,
    secrets: Record<string, string>,
  ): Harness {
    const c = config as AnthropicConfig;
    const apiKey = secrets.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Anthropic harness was instantiated without ANTHROPIC_API_KEY in its secrets bundle",
      );
    }
    return new AnthropicHarness(
      c.model ?? "claude-sonnet-4-5-latest",
      apiKey,
      c.apiBase ?? "https://api.anthropic.com",
      c.maxTokens ?? 4096,
      c.maxTurnRequests ?? 16,
      c.stream ?? true,
    );
  },
};
