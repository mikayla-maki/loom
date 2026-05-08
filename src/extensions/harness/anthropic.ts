/**
 * Anthropic harness — calls the Messages API directly via fetch.
 *
 * Config:
 *   model: string                   (required)
 *   apiKey: string                  (optional; otherwise ANTHROPIC_API_KEY)
 *   apiBase: string                 (optional; for proxies / mocks)
 *   maxTokens: number               (default 4096)
 *   maxTurnRequests: number         (default 16; soft cap on model calls per turn)
 *   stream: boolean                 (default true; emit text deltas as they arrive)
 *
 * Translation:
 *   - SessionUpdate `user_message_chunk`  → `{ role: "user", content: [...] }`
 *   - SessionUpdate `agent_message_chunk` → `{ role: "assistant", ... }`
 *   - tool_call / tool_call_update        → tool_use / tool_result blocks
 *
 * The harness keeps requesting the model while the assistant returns
 * tool_use blocks; once it returns a pure text response (no tool_use), the
 * turn ends with `end_turn`.
 *
 * Streaming:
 *   When `stream: true`, the harness consumes the SSE stream and emits
 *   one `agent_message_chunk` per text delta — so consumers see tokens
 *   land in real time. Tool-use input is buffered until the block
 *   completes (the API streams the JSON args incrementally; loom needs
 *   the full input before dispatching). The final assembled response
 *   carries the same shape as the non-streaming path so the dispatch
 *   loop is identical.
 */

import type {
  SessionUpdate,
  StopReason,
  ToolCallStatus,
  TurnUsage,
} from "../../types/acp.js";
import type {
  ExtensionContext,
  Harness,
  HarnessFactory,
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

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicResponse {
  id: string;
  role: "assistant";
  content: AnthropicContentBlock[];
  stop_reason:
    | "end_turn"
    | "tool_use"
    | "max_tokens"
    | "stop_sequence"
    | string;
  /** Model name as reported by the API. May be more specific than the
   *  configured value (e.g. dated alias resolves to a concrete version). */
  model?: string;
  usage?: AnthropicUsage;
}

/**
 * Subset of the `/v1/models/{id}` response we consume. Anthropic
 * documents `context_window` and `max_output_tokens`; we read the first.
 */
interface AnthropicModelInfo {
  id: string;
  context_window?: number;
  max_output_tokens?: number;
}

export class AnthropicHarness implements Harness {
  /**
   * Lazy cache of `/v1/models/{id}` responses, keyed by model id. We
   * fetch on first usage emission and reuse for the lifetime of the
   * harness instance. A failure caches `null`, so we don't retry every
   * turn.
   */
  private modelInfoCache = new Map<string, AnthropicModelInfo | null>();
  private modelInfoInflight = new Map<
    string,
    Promise<AnthropicModelInfo | null>
  >();

  /** Cumulative usage across the current turn. Reset at each `run()` start. */
  private turnUsage: TurnUsage | null = null;

  constructor(
    private readonly model: string,
    private readonly apiKey: string,
    private readonly apiBase: string,
    private readonly maxTokens: number,
    private readonly maxTurnRequests: number,
    private readonly stream: boolean = true,
  ) {}

  /**
   * Native summarisation. Anthropic doesn't expose a dedicated
   * summarise endpoint, but the Messages API with no tools and a
   * single combined prompt is exactly the same shape and skips the
   * synthetic-runtime indirection. Loom's `summariseViaRun` would
   * arrive at the same result; this is the cheaper path.
   */
  async summarise(args: SummariseArgs): Promise<string> {
    const messages = this.eventsToMessages(args.events);
    // Append the instruction as the final user turn so the model sees
    // it as the last thing said.
    messages.push({
      role: "user",
      content: [{ type: "text", text: args.instruction }],
    });
    const signal = args.abortSignal ?? new AbortController().signal;
    const response = await this.callAPI(
      args.systemPrompt,
      messages,
      [],
      signal,
      undefined, // not streaming — caller wants a single string
    );
    return response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
  }

  async run(runtime: Runtime): Promise<TurnResult> {
    let requests = 0;
    // Reset cumulative usage for this turn.
    this.turnUsage = null;
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
      const tools = runtime.listTools().map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));

      // In streaming mode we surface text as it arrives; the response
      // we get back at the end is the assembled message — its text
      // blocks are NOT re-surfaced.
      let textAlreadyEmitted = false;
      const onTextDelta = this.stream
        ? async (delta: string) => {
            textAlreadyEmitted = true;
            await runtime.update({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: delta },
            });
          }
        : undefined;

      let response: AnthropicResponse;
      try {
        response = await this.callAPI(
          runtime.systemPrompt(),
          messages,
          tools,
          runtime.abortSignal,
          onTextDelta,
        );
      } catch (e) {
        await runtime.update({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `[anthropic error] ${(e as Error).message}`,
          },
        });
        await runtime.update({ sessionUpdate: "stop", stopReason: "error" });
        return this.finishTurn("error");
      }

      // Update cumulative turn usage and emit a usage_update event.
      // We do this BEFORE dispatching tools so the indicator reflects
      // the true post-response state.
      if (response.usage) {
        this.accumulateUsage(response.usage);
        await this.emitUsageUpdate(
          runtime,
          response.usage,
          response.model ?? this.model,
        );
      }

      // Surface text blocks that didn't arrive via streaming, and
      // record any tool_use blocks for dispatch.
      const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
      for (const block of response.content) {
        if (block.type === "text" && block.text && !textAlreadyEmitted) {
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
        await runtime.update({
          sessionUpdate: "stop",
          stopReason: "max_tokens",
        });
        return this.finishTurn("max_tokens");
      }

      if (toolUses.length === 0) {
        await runtime.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return this.finishTurn("end_turn");
      }

      // Dispatch tools in parallel.
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
          await runtime.update({
            sessionUpdate: "tool_call_update",
            toolCallId: tu.id,
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
      // Loop continues; next call will rebuild messages including tool_results.
    }
  }

  /** Wrap a stop reason with the turn's accumulated usage (if any). */
  private finishTurn(stopReason: StopReason): TurnResult {
    if (this.turnUsage) {
      return { stopReason, usage: this.turnUsage };
    }
    return { stopReason };
  }

  /** Add a per-request usage payload into this turn's cumulative tally. */
  private accumulateUsage(u: AnthropicUsage): void {
    if (!this.turnUsage) {
      this.turnUsage = { inputTokens: 0, outputTokens: 0 };
    }
    this.turnUsage.inputTokens += u.input_tokens;
    this.turnUsage.outputTokens += u.output_tokens;
    if (u.cache_read_input_tokens !== undefined) {
      this.turnUsage.cachedReadTokens =
        (this.turnUsage.cachedReadTokens ?? 0) + u.cache_read_input_tokens;
    }
    if (u.cache_creation_input_tokens !== undefined) {
      this.turnUsage.cachedWriteTokens =
        (this.turnUsage.cachedWriteTokens ?? 0) + u.cache_creation_input_tokens;
    }
  }

  /**
   * Emit a `usage_update` SessionUpdate. `used` is the most-recent
   * request's input + output (a near-perfect reading of "tokens
   * currently in context"). `size` comes from the lazy model-info
   * fetch; if unavailable, we fall back to a sentinel of 0 and clients
   * render "used" alone (the indicator degrades gracefully).
   */
  private async emitUsageUpdate(
    runtime: Runtime,
    u: AnthropicUsage,
    modelId: string,
  ): Promise<void> {
    const used = u.input_tokens + u.output_tokens;
    const info = await this.fetchModelInfo(modelId, runtime.abortSignal);
    const size = info?.context_window ?? 0;
    await runtime.update({
      sessionUpdate: "usage_update",
      used,
      size,
    });
  }

  /**
   * Lazily fetch and cache `/v1/models/{id}`. Returns null on failure;
   * the failure is also cached so we don't retry on every turn.
   */
  private async fetchModelInfo(
    modelId: string,
    signal: AbortSignal,
  ): Promise<AnthropicModelInfo | null> {
    if (this.modelInfoCache.has(modelId)) {
      return this.modelInfoCache.get(modelId) ?? null;
    }
    const inflight = this.modelInfoInflight.get(modelId);
    if (inflight) return await inflight;

    const promise = (async (): Promise<AnthropicModelInfo | null> => {
      try {
        const url = `${this.apiBase.replace(/\/$/, "")}/v1/models/${encodeURIComponent(modelId)}`;
        const res = await fetch(url, {
          method: "GET",
          headers: {
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          signal,
        });
        if (!res.ok) return null;
        return (await res.json()) as AnthropicModelInfo;
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

  private eventsToMessages(events: SessionUpdate[]): AnthropicMessage[] {
    const messages: AnthropicMessage[] = [];
    let current: AnthropicMessage | null = null;
    const pendingToolUseById = new Map<
      string,
      { name: string; input: unknown }
    >();

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
            push({
              role: "user",
              content: [{ type: "text", text: e.content.text }],
            });
          }
          break;
        }
        case "agent_message_chunk": {
          if (e.content.type === "text") {
            push({
              role: "assistant",
              content: [{ type: "text", text: e.content.text }],
            });
          }
          break;
        }
        case "agent_thought_chunk":
          // Thoughts are not sent back to the API in v0.
          break;
        case "tool_call": {
          pendingToolUseById.set(e.toolCallId, {
            name: e.title,
            input: e.input,
          });
          push({
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: e.toolCallId,
                name: e.title,
                input: e.input ?? {},
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

  private async callAPI(
    system: string,
    messages: AnthropicMessage[],
    tools: Array<{ name: string; description: string; input_schema: unknown }>,
    signal: AbortSignal,
    onTextDelta: ((delta: string) => Promise<void> | void) | undefined,
  ): Promise<AnthropicResponse> {
    const url = `${this.apiBase.replace(/\/$/, "")}/v1/messages`;
    const useStreaming = this.stream && onTextDelta !== undefined;
    const body = {
      model: this.model,
      system,
      messages,
      tools,
      max_tokens: this.maxTokens,
      ...(useStreaming ? { stream: true } : {}),
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
    if (useStreaming) {
      return await this.consumeStream(res, onTextDelta!);
    }
    return (await res.json()) as AnthropicResponse;
  }

  /**
   * Parse Anthropic's SSE stream into a final `AnthropicResponse`,
   * surfacing text deltas via `onTextDelta` as they arrive.
   *
   * The wire format (abbreviated):
   *   event: message_start         data: { message: { id, role, ... } }
   *   event: content_block_start   data: { index, content_block: {...} }
   *   event: content_block_delta   data: { index, delta: {...} }
   *   event: content_block_stop    data: { index }
   *   event: message_delta         data: { delta: { stop_reason, ... } }
   *   event: message_stop          data: {}
   *
   * We only care about the data payloads; the `event:` line is just a
   * label for what to expect. We consult the `type` field on the JSON
   * to dispatch.
   */
  private async consumeStream(
    res: Response,
    onTextDelta: (delta: string) => Promise<void> | void,
  ): Promise<AnthropicResponse> {
    if (!res.body) {
      throw new Error("Anthropic stream returned no body");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    let id = "";
    let model: string | undefined;
    const blocks: AnthropicContentBlock[] = [];
    // Per-index buffers for partial tool_use input JSON.
    const toolInputBufs = new Map<number, string>();
    let stopReason: AnthropicResponse["stop_reason"] = "end_turn";
    // Usage accumulates across the SSE: message_start carries
    // input_tokens (and an initial output_tokens), message_delta carries
    // an updated output_tokens. We hold the latest snapshot.
    let usage: AnthropicUsage | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line. Parse each completed
      // event and leave any trailing partial in `buffer`.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        const dataStr = dataLines.join("\n");
        if (!dataStr) continue;
        let evt: unknown;
        try {
          evt = JSON.parse(dataStr);
        } catch {
          continue;
        }
        if (typeof evt !== "object" || evt === null) continue;
        const o = evt as Record<string, unknown>;
        const t = o.type;

        if (t === "message_start") {
          const m = (o.message ?? {}) as Record<string, unknown>;
          if (typeof m.id === "string") id = m.id;
          if (typeof m.model === "string") model = m.model;
          const u = m.usage as Record<string, unknown> | undefined;
          if (u) usage = parseAnthropicUsage(u);
        } else if (t === "content_block_start") {
          const idx = typeof o.index === "number" ? o.index : -1;
          const cb = (o.content_block ?? {}) as Record<string, unknown>;
          if (cb.type === "text") {
            blocks[idx] = { type: "text", text: "" };
          } else if (cb.type === "tool_use") {
            blocks[idx] = {
              type: "tool_use",
              id: typeof cb.id === "string" ? cb.id : "",
              name: typeof cb.name === "string" ? cb.name : "",
              input: {},
            };
            toolInputBufs.set(idx, "");
          }
        } else if (t === "content_block_delta") {
          const idx = typeof o.index === "number" ? o.index : -1;
          const d = (o.delta ?? {}) as Record<string, unknown>;
          if (d.type === "text_delta" && typeof d.text === "string") {
            const existing = blocks[idx];
            if (existing && existing.type === "text") {
              existing.text += d.text;
            }
            await onTextDelta(d.text);
          } else if (
            d.type === "input_json_delta" &&
            typeof d.partial_json === "string"
          ) {
            const buf = toolInputBufs.get(idx) ?? "";
            toolInputBufs.set(idx, buf + d.partial_json);
          }
        } else if (t === "content_block_stop") {
          const idx = typeof o.index === "number" ? o.index : -1;
          const buf = toolInputBufs.get(idx);
          if (buf !== undefined) {
            const block = blocks[idx];
            if (block && block.type === "tool_use") {
              try {
                block.input = buf ? JSON.parse(buf) : {};
              } catch {
                block.input = { _rawArgs: buf };
              }
            }
            toolInputBufs.delete(idx);
          }
        } else if (t === "message_delta") {
          const d = (o.delta ?? {}) as Record<string, unknown>;
          if (typeof d.stop_reason === "string") {
            stopReason = d.stop_reason;
          }
          // The cumulative output_tokens lives on `message_delta.usage`.
          const u = o.usage as Record<string, unknown> | undefined;
          if (u) usage = mergeAnthropicUsage(usage, parseAnthropicUsage(u));
        } else if (t === "message_stop") {
          // nothing further to read
        } else if (t === "ping") {
          // heartbeat
        } else if (t === "error") {
          const err = (o.error ?? {}) as Record<string, unknown>;
          throw new Error(
            `Anthropic stream error: ${err.message ?? JSON.stringify(err)}`,
          );
        }
      }
    }

    // Filter out any holes (defensive — content_block_start should
    // always run before its deltas).
    const content = blocks.filter((b): b is AnthropicContentBlock => !!b);
    const result: AnthropicResponse = {
      id,
      role: "assistant",
      content,
      stop_reason: stopReason,
    };
    if (model !== undefined) result.model = model;
    if (usage !== undefined) result.usage = usage;
    return result;
  }
}

/** Read the subset of fields we care about off an Anthropic usage payload. */
function parseAnthropicUsage(u: Record<string, unknown>): AnthropicUsage {
  const out: AnthropicUsage = {
    input_tokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
    output_tokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
  };
  if (typeof u.cache_read_input_tokens === "number") {
    out.cache_read_input_tokens = u.cache_read_input_tokens;
  }
  if (typeof u.cache_creation_input_tokens === "number") {
    out.cache_creation_input_tokens = u.cache_creation_input_tokens;
  }
  return out;
}

/**
 * Merge a fresh usage snapshot into an existing one. Output tokens
 * arrive cumulative on `message_delta`, so we overwrite when present
 * rather than summing. Input tokens come once on `message_start` and
 * don't change.
 */
function mergeAnthropicUsage(
  prev: AnthropicUsage | undefined,
  next: AnthropicUsage,
): AnthropicUsage {
  if (!prev) return next;
  const merged: AnthropicUsage = {
    input_tokens: prev.input_tokens || next.input_tokens,
    output_tokens: next.output_tokens || prev.output_tokens,
  };
  if (
    next.cache_read_input_tokens !== undefined ||
    prev.cache_read_input_tokens !== undefined
  ) {
    merged.cache_read_input_tokens =
      next.cache_read_input_tokens ?? prev.cache_read_input_tokens;
  }
  if (
    next.cache_creation_input_tokens !== undefined ||
    prev.cache_creation_input_tokens !== undefined
  ) {
    merged.cache_creation_input_tokens =
      next.cache_creation_input_tokens ?? prev.cache_creation_input_tokens;
  }
  return merged;
}

export const anthropicHarnessFactory: HarnessFactory = {
  name: "anthropic",
  secrets: { required: ["ANTHROPIC_API_KEY"] },
  create(
    config: Record<string, unknown>,
    _ctx: ExtensionContext,
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
      c.model ?? "claude-3-5-sonnet-latest",
      apiKey,
      c.apiBase ?? "https://api.anthropic.com",
      c.maxTokens ?? 4096,
      c.maxTurnRequests ?? 16,
      c.stream ?? true,
    );
  },
};
