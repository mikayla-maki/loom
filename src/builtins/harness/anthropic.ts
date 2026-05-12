/**
 * Anthropic harness — Messages API via the official `@anthropic-ai/sdk`.
 *
 * Config:
 *   model: string                   (default `claude-sonnet-4-5-latest`)
 *   apiKey: string                  (optional; otherwise ANTHROPIC_API_KEY)
 *   apiBase: string                 (optional; default api.anthropic.com)
 *   maxTokens: number               (default 4096)
 *   maxTurnRequests: number         (default 16; soft cap on model calls per turn)
 *   stream: boolean                 (default true; emit text + thinking deltas live)
 *
 * Translation:
 *   - `user_message_chunk`   → `{ role: "user", content: [...] }` (text + image)
 *   - `agent_message_chunk`  → `{ role: "assistant", content: [...] }` (text)
 *   - `agent_thought_chunk`  → not echoed back to the API (thinking is one-way)
 *   - `tool_call`            → `tool_use` block on the assistant turn
 *   - `tool_call_update`     → `tool_result` block on the user turn (text only)
 *
 * Image support flows via ACP's `{ type: "image", mimeType, data }`
 * `ContentBlock` (base64). The harness packs it into Anthropic's
 * `{ type: "image", source: { type: "base64", media_type, data } }`.
 *
 * Reasoning ("thinking"):
 *   - `params.thinking` is forwarded verbatim (when set), so callers can
 *     pass the full `ThinkingConfigParam` shape (`{ type: "enabled",
 *     budget_tokens }`, `{ type: "adaptive" }`, `{ type: "disabled" }`).
 *   - `params.effort` is forwarded via `output_config.effort` — Anthropic
 *     accepts the same `low | medium | high | xhigh | max` vocabulary.
 *
 * Loop:
 *   The harness re-requests the model while the assistant returns
 *   `tool_use` blocks; once it returns text-only (no tool_use), the turn
 *   ends with `end_turn`. `maxTurnRequests` is a soft cap on per-turn
 *   API requests so runaway tool loops can't burn through credits.
 *
 * Streaming:
 *   With `stream: true` the SDK's high-level `MessageStream` is consumed
 *   via its `text` / `thinking` events, which emit deltas as they
 *   arrive. The final assembled `Message` is taken from
 *   `stream.finalMessage()` so the post-stream code is identical to the
 *   non-stream path.
 */

import Anthropic, { APIUserAbortError } from "@anthropic-ai/sdk";
import type {
  ContentBlock as AnthropicContentBlock,
  ContentBlockParam,
  Message as AnthropicMessage,
  MessageCreateParamsBase,
  MessageParam,
  Tool as AnthropicTool,
  Usage as AnthropicUsage,
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
  FactoryContext,
  Harness,
  HarnessFactory,
  HarnessModel,
  RunParameters,
  Runtime,
  SummariseArgs,
  TurnResult,
} from "../../types/interfaces.js";

interface AnthropicConfig {
  model?: string;
  apiBase?: string;
  maxTokens?: number;
  maxTurnRequests?: number;
  stream?: boolean;
}

/** MIME types Anthropic accepts on `image` content blocks. */
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

  /**
   * Lazy cache of `client.models.retrieve(modelId)` responses. Failures
   * cache `null` so we don't retry every turn.
   */
  private modelInfoCache = new Map<string, ModelInfo | null>();
  private modelInfoInflight = new Map<string, Promise<ModelInfo | null>>();

  /** Cumulative usage across the current turn. Reset at each `run()` start. */
  private turnUsage: TurnUsage | null = null;

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

  /**
   * Implements the optional `Harness.withModel` API — returns a
   * sibling harness with the same credentials/transport but a
   * different model id. Used by parent-derived harness factories
   * (e.g. `small-model-of-parent`) that want to reuse the parent's
   * API key + transport but route to a cheaper or faster model.
   */
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

  /**
   * Implements the optional `Harness.smallModel` API — returns the
   * id of a smaller/faster sibling of the currently-configured
   * model. Pattern-matches `sonnet`/`opus` → `haiku` in-family;
   * falls back to a known fast default (`claude-haiku-4-5`) when
   * the current model id doesn't match a known pattern.
   */
  smallModel(): string {
    const m = this.model;
    if (m.includes("haiku")) return m;
    if (m.includes("sonnet")) return m.replace("sonnet", "haiku");
    if (m.includes("opus")) return m.replace("opus", "haiku");
    return "claude-haiku-4-5";
  }

  /**
   * Implements `Harness.currentModel` — the model id this harness
   * is currently configured to route to.
   */
  currentModel(): string {
    return this.model;
  }

  /**
   * Lazy cache of `client.models.list()`. Populated on first call;
   * a failed list call caches `[]` so the ACP server doesn't spin
   * on retries.
   */
  private modelsListCache: HarnessModel[] | null = null;
  private modelsListInflight: Promise<HarnessModel[]> | null = null;

  /**
   * Implements `Harness.models` — returns the list of models the
   * Anthropic API advertises for this account, mapped to the
   * Loom-shaped `HarnessModel`. Cached after the first successful
   * call. The ACP server uses this to populate the `model` entry
   * in `configOptions` at `session/new` time.
   */
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
        // Cache the empty result so we don't retry on every call.
        // Callers tolerate an empty array ("no model selector").
        this.modelsListCache = [];
        return [];
      } finally {
        this.modelsListInflight = null;
      }
    })();
    return this.modelsListInflight;
  }

  /**
   * Native summarisation. The Messages API with no tools and a single
   * combined prompt is exactly the shape we want, and skips the
   * synthetic-runtime indirection that `summariseViaRun` would do.
   */
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
      const tools: AnthropicTool[] = runtime.listTools().map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as AnthropicTool["input_schema"],
      }));

      const body: MessageCreateParamsBase = {
        model: turnModel,
        max_tokens: turnMaxTokens,
        system: runtime.systemPrompt(),
        messages,
        tools,
      };
      // `thinking` (when set) wins over `effort` since it's the more
      // specific knob. Both flow through to the API verbatim.
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
        // Don't pollute the session log with the error text — it isn't
        // an assistant utterance. Stop with `error`; the runtime's
        // consumer (ACP server, CLI REPL, SDK caller) renders
        // `result.error.message` however it likes.
        await runtime.update({ sessionUpdate: "stop", stopReason: "error" });
        return this.finishTurn("error", {
          message: `[anthropic] ${(e as Error).message}`,
        });
      }

      // Usage first, so the indicator reflects the true post-response state.
      if (response.usage) {
        this.accumulateUsage(response.usage);
        await this.emitUsageUpdate(
          runtime,
          response.usage,
          response.model ?? turnModel,
        );
      }

      // Collect tool_use blocks for dispatch.
      const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          toolUses.push({
            id: block.id,
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

      // Dispatch tools in parallel; surface results as tool_call_update.
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
          // Split: session stores the text-only model-facing record;
          // ACP clients receive the rich `display` payload (terminal
          // blocks, diff blocks, kind, locations). See
          // `Runtime.emitToolResult` for the rationale.
          await runtime.emitToolResult({
            toolCallId: tu.id,
            status,
            modelContent: result.content,
            ...(result.display ? { display: result.display } : {}),
          });
        }),
      );
      // Next iteration: messages include the tool_results.
    }
  }

  /**
   * Non-streaming path: one `messages.create()` call. Text and tool_use
   * blocks land via post-response emission.
   */
  private async runNonStreaming(
    body: MessageCreateParamsBase,
    runtime: Runtime,
  ): Promise<AnthropicMessage> {
    const response = await this.client.messages.create(
      { ...body, stream: false },
      { signal: runtime.abortSignal },
    );
    // Emit text + thinking blocks (no live streaming in this path).
    for (const block of response.content) {
      if (block.type === "text" && block.text) {
        await runtime.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: block.text },
        });
      } else if (block.type === "thinking" && block.thinking) {
        await runtime.update({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: block.thinking },
        });
      }
    }
    return response;
  }

  /**
   * Streaming path: surface text and thinking deltas as they arrive
   * via the SDK's high-level `MessageStream` event surface. The final
   * `Message` is taken from `finalMessage()` and returned for the
   * common post-response code (tool dispatch, usage, etc.).
   */
  private async runStreaming(
    body: MessageCreateParamsBase,
    runtime: Runtime,
  ): Promise<AnthropicMessage> {
    const stream = this.client.messages.stream(
      { ...body, stream: true },
      { signal: runtime.abortSignal },
    );
    // Forward delta emissions sequentially. We don't await each emit
    // inside the listener (the event surface is synchronous); ordering
    // is preserved by listening to a single source.
    let emitChain: Promise<void> = Promise.resolve();
    const enqueue = (update: SessionUpdate): void => {
      emitChain = emitChain.then(() => runtime.update(update));
    };
    stream.on("text", (delta) => {
      if (delta) {
        enqueue({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: delta },
        });
      }
    });
    stream.on("thinking", (delta) => {
      if (delta) {
        enqueue({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: delta },
        });
      }
    });
    const final = await stream.finalMessage();
    await emitChain; // make sure every queued delta has actually flushed
    return final;
  }

  /**
   * Wrap a stop reason with the turn's accumulated usage (if any) and
   * the optional error message (when `stopReason === "error"`).
   */
  private finishTurn(
    stopReason: StopReason,
    error?: { message: string },
  ): TurnResult {
    const result: TurnResult = { stopReason };
    if (this.turnUsage) result.usage = this.turnUsage;
    if (error) result.error = error;
    return result;
  }

  /** Fold a per-request usage payload into the turn's cumulative tally. */
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

  /**
   * Emit a `usage_update` SessionUpdate. `used` = the most-recent
   * request's input + output (close enough to "tokens currently in
   * context" for the indicator); `size` comes from the lazy model-info
   * fetch. Missing context window → sentinel 0; clients render "used"
   * alone.
   */
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

  /**
   * Lazy-fetch and cache `client.models.retrieve(modelId)`. Returns
   * null on failure (also cached so we don't retry per turn).
   */
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

  /**
   * Translate the session-side event log into the Anthropic-shaped
   * message list. Consecutive same-role chunks coalesce into a single
   * `MessageParam` so the API sees natural turns. Image content blocks
   * pass through as `image` blocks; unknown MIME types are dropped with
   * a textual placeholder so the model still gets context.
   */
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
          // Thinking is one-way: we don't echo it back to the API.
          break;
        case "tool_call": {
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

/**
 * Translate an ACP `ContentBlock` to an Anthropic `ContentBlockParam`.
 * Returns null when the block isn't representable (e.g., a resource
 * block whose MIME isn't supported by the image API).
 */
function acpToAnthropicContent(
  block: ACPContentBlock,
): ContentBlockParam | null {
  if (block.type === "text") {
    return block.text ? { type: "text", text: block.text } : null;
  }
  if (block.type === "image") {
    if (!isAnthropicImageMediaType(block.mimeType)) {
      // Drop with a textual placeholder so the model still has context.
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
    // Resource blocks aren't a thing on Anthropic; degrade to text.
    const res = block.resource;
    const text =
      "text" in res && typeof res.text === "string"
        ? res.text
        : `[resource: ${res.uri}]`;
    return { type: "text", text };
  }
  return null;
}

// Re-exported so the existing `parent-derived.ts` `withModel` consumer
// keeps working. Not part of the public SDK surface.
export type { AnthropicContentBlock };

export const anthropicHarnessFactory: HarnessFactory = {
  name: "anthropic",
  secrets: { required: ["ANTHROPIC_API_KEY"] },
  // Anthropic Messages API accepts inline image content and embedded
  // resources in `session/prompt`. Audio isn't supported. Reported at
  // `initialize` time — the factory doesn't need to instantiate a
  // harness to know its model family's content capabilities.
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
      // Should never happen — the runtime validates required secrets
      // before calling create(). Defensive guard for direct callers.
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
