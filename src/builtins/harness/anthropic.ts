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

// ─── Server-tool catalog ─────────────────────────────────────────────────
//
// Tools the harness dispatches API-side (not through the runtime's
// ToolTable). The manifest opts in by listing one in `[tools.<name>]`
// with `provider = "anthropic"`; the resolver routes the binding to
// `Harness.resolveTool`, and `run()` translates it into the API's
// native server-tool shape on the way out.
//
// Pinned to the `_20250305` revision for `web_search` and the
// `_20250910` revision for `web_fetch`. The Anthropic SDK exposes
// newer revisions; we'll bump deliberately when their behaviour
// surface stabilises.

interface ServerToolSpec {
  /** Model-facing name surfaced via `runtime.listTools()`. */
  name: string;
  /** What the tool does, for system-prompt enumeration / audit. */
  description: string;
  /** Input shape the model fills out. Documentation-only — the API enforces. */
  inputSchema: JSONSchema;
  /**
   * Capability kinds this tool understands. Listed in the stub Tool's
   * `optional` array so `assertKnownKinds` accepts grants like
   * `web_search = { allowed_domains = [...] }`. Per the
   * positive/declarative/closed-by-default convention, the allow-list
   * surface lives here; exclusionary (`blocked_domains`) and pure-
   * knob (`max_uses`, `user_location`) shapes stay as config.
   */
  capabilityKinds: string[];
  /**
   * Build the API-side `ToolUnion` entry from per-tool config and
   * the granted capability set. `allowed_domains` (when present)
   * comes from `capabilities`, never from `config`.
   */
  toApiTool(
    config: ToolConfig,
    capabilities: CapabilitySet | undefined,
  ): AnthropicToolUnion;
}

/** Helpers for translating common config keys uniformly. */
function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((s): s is string => typeof s === "string");
  return arr.length > 0 ? arr : undefined;
}

/**
 * Read the `allowed_domains` allow-list from a capability grant.
 * Returns undefined when the capability is missing, `"*"`, or shaped
 * such that no narrowing applies — in which case the API call is
 * sent without an `allowed_domains` filter (Anthropic's default of
 * "any domain" applies).
 */
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
      // `allowed_domains` is the declarative allow-list — a capability.
      const allowed = allowedDomainsCapability(capabilities);
      if (allowed) out.allowed_domains = allowed;
      // `blocked_domains` is exclusionary — stays in config.
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
      // `citations: { enabled: true }` is the only shape worth
      // forwarding for now; users who want richer config can pass
      // the full object through.
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

/** Stub Tool for harness-exposed server tools. Defensive `execute()`. */
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
    // Declared so `assertKnownKinds` accepts grants like
    // `web_search = { allowed_domains = [...] }`. None are `requires`
    // — a missing capability just means no narrowing on the API call.
    this.optional = [...spec.capabilityKinds];
  }
  async execute(): Promise<ToolResult> {
    // The harness intercepts dispatch for server tools in its run
    // loop, so this path should be unreachable. We return an error
    // rather than throwing so a misrouted call surfaces cleanly.
    return {
      content:
        `[anthropic] '${this.name}' is a server-side tool dispatched by ` +
        `the harness; it shouldn't have been routed through ToolTable. ` +
        `This is a runtime bug.`,
      isError: true,
    };
  }
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

  /**
   * Per-tool config for harness-exposed server tools, keyed by name.
   * Populated by {@link resolveTool} as the runtime binds opted-in
   * tools; read by `run()` when translating `runtime.listTools()`
   * into the API's `ToolUnion[]`. Cleared when this harness is
   * cloned via `withModel` because the runtime always re-binds
   * tools for the cloned agent.
   */
  private serverToolConfigs = new Map<string, ToolConfig>();

  /**
   * Per-tool capability grants for harness-exposed server tools.
   * Populated alongside {@link serverToolConfigs}. Distinct from
   * config because the manifest's `[capabilities]` block is the
   * source of declarative allow-lists (`allowed_domains`), kept
   * separate from knob-style config (`max_uses`, `user_location`,
   * `blocked_domains`).
   */
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

  /**
   * Implements `Harness.availableTools` — the catalog of server-
   * side tools the manifest may opt into by listing them under
   * `[tools.<name>] provider = "anthropic"`. Returning these here
   * lets the resolver route those bindings to this harness rather
   * than failing with "no matching [providers] entry or built-in".
   *
   * Not auto-added — see the docs on `Harness.availableTools`.
   */
  availableTools(): { name: string; config: ToolConfig }[] {
    return Object.values(SERVER_TOOLS).map((s) => ({
      name: s.name,
      config: {},
    }));
  }

  /**
   * Implements `Harness.resolveTool` — returns a stub Tool for a
   * harness-exposed name, or null when the name isn't in the
   * catalog. The stub's `execute()` is defensive only; the harness
   * intercepts dispatch in `run()` because server tools resolve
   * API-side.
   *
   * Side effect: records the per-tool config in
   * {@link serverToolConfigs} so `run()` can read it when building
   * the API request body (passing through `max_uses`,
   * `allowed_domains`, `user_location`, etc.).
   */
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

  /**
   * Implements the optional `Harness.withModel` API — returns a
   * sibling harness with the same credentials/transport but a
   * different model id. Used by parent-derived harness factories
   * (e.g. `small-model-of-parent`) that want to reuse the parent's
   * API key + transport but route to a cheaper or faster model.
   *
   * Server-tool configs are NOT copied: the sub-agent gets a fresh
   * binding pass and the runtime will call `resolveTool` again for
   * any opt-ins it lists.
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
      // Partition tools into:
      //   * client-dispatched ("regular" Tools the model invokes via
      //     `tool_use` and we run via `runtime.executeTool`), and
      //   * harness-exposed server tools (translated into the API's
      //     native server-tool shape; Anthropic runs them in-API
      //     and returns `server_tool_use` + `*_tool_result` blocks).
      // The split is by name lookup against the harness's server-
      // tool catalog — the manifest opted into these by listing
      // them with `provider = "anthropic"`, which routed binding
      // through `Harness.resolveTool`.
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

      // Walk the response content to:
      //   * collect client-side `tool_use` blocks for dispatch via
      //     `runtime.executeTool` (the regular path), and
      //   * surface `server_tool_use` + `*_tool_result` block pairs
      //     as `tool_call` + `tool_call_update` events for the
      //     session log + ACP client display, WITHOUT dispatching
      //     them — they already ran server-side, and the result is
      //     baked into this same assistant message.
      //
      // Server-tool pairing: `*_tool_result` blocks reference their
      // originating `server_tool_use` by id (`tool_use_id`), and the
      // model's text continues after the result in the same message,
      // so the ACP client sees “title: web_search” → “result: …” in
      // order alongside the surrounding text deltas.
      const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
      const serverToolUses = new Map<
        string,
        { name: string; input: unknown }
      >();
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
        } else if (block.type === "server_tool_use") {
          // Emit the call event so it shows up in the session log
          // and ACP UIs alongside the eventual result. The `title`
          // is the tool name (matches client-side tool_use). We
          // remember the pairing so the matching result block can
          // attach its rendered text below.
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
        } else if (
          block.type === "web_search_tool_result" ||
          block.type === "web_fetch_tool_result"
        ) {
          await this.emitServerToolResult(runtime, block, serverToolUses);
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
      // Note: server tools are NOT in `toolUses` — they already ran
      // API-side and their results were emitted above.
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
   * Render a server-tool result block (`web_search_tool_result` /
   * `web_fetch_tool_result`) as a `tool_call_update` event. The
   * model-facing text is a markdown summary; the rich `rawOutput`
   * carries the raw Anthropic block so ACP clients can render
   * citations / encrypted content / full document text if they want.
   *
   * The paired `server_tool_use` block was already emitted as a
   * `tool_call`; we look up its name from `serverToolUses` to write
   * a sensible title on the update.
   */
  private async emitServerToolResult(
    runtime: Runtime,
    block: WebSearchToolResultBlock | WebFetchToolResultBlock,
    serverToolUses: Map<string, { name: string; input: unknown }>,
  ): Promise<void> {
    // The raw block goes on `display.rawOutput` — see `runtime.ts`,
    // `emitToolResult`. That field now flows into the session record
    // as well as the client emit, so `eventsToMessages` can read it
    // back on subsequent turns to replay the proper
    // `server_tool_use` + `*_tool_result` pair (with
    // `encrypted_content` preserved) without keeping a parallel
    // in-memory cache.
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

    // Identify server-tool exchanges and collect their replay
    // payloads in one pre-pass. They're always emitted as a
    // server_tool_use + *_tool_result pair in the assistant message;
    // the paired `tool_call_update` event is skipped in the main
    // pass (sending it as a user tool_result would collide with the
    // server-tool declaration in the request `tools` array).
    //
    // The result block comes from `tool_call_update.rawOutput` —
    // populated by `emitServerToolResult` and persisted into the
    // session by `Runtime.emitToolResult` alongside the model-facing
    // text. When `rawOutput` is missing (e.g., a compacting session
    // dropped it, or some other path produced an update without the
    // raw block), we emit a placeholder `error_code: "unavailable"`
    // result — honest about the loss, structurally valid for the API.
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
          // Thinking is one-way: we don't echo it back to the API.
          break;
        case "tool_call": {
          const server = serverPayloads.get(e.toolCallId);
          if (server) {
            // Server-tool path. Always emit the pair; the result block
            // is the persisted real one when present, else a placeholder
            // `unavailable` block. Matching `tool_call_update` skipped
            // below (handled by the same `serverPayloads` membership).
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

/**
 * Type guard for the result blocks the harness recognises on
 * `tool_call_update.rawOutput`. The session field is typed `unknown`
 * because anything can land there; we only treat it as a server-tool
 * result when its `type` matches one of the shapes we know how to
 * round-trip into the API.
 */
function isServerToolResultBlock(
  v: unknown,
): v is WebSearchToolResultBlock | WebFetchToolResultBlock {
  if (typeof v !== "object" || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return t === "web_search_tool_result" || t === "web_fetch_tool_result";
}

/**
 * Build the assistant-content blocks for a server-tool turn: a
 * `server_tool_use` block paired with its `*_tool_result` block,
 * both shaped as `ContentBlockParam`s for the request side.
 *
 * When `result` is present, we use its response shape directly —
 * `WebSearchToolResultBlock` / `WebFetchToolResultBlock` are
 * structurally compatible with their Param counterparts (same
 * fields, the Param versions just make `caller` optional and add
 * `cache_control`). A structural cast preserves `encrypted_content`
 * and any other opaque payload Anthropic adds in future revisions.
 *
 * When `result` is undefined (cache miss across harness lifetimes),
 * we emit a placeholder result block with
 * `error_code: "unavailable"`. The model sees the call happened but
 * understands the content is no longer accessible. Honest and
 * structurally valid; the API accepts it.
 */
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

/**
 * Build a placeholder result block for a server-tool call whose
 * original result is no longer in the harness's cache. Uses the
 * `unavailable` error code, which both `WebSearchToolResultErrorCode`
 * and `WebFetchToolResultErrorCode` advertise for this purpose.
 */
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
  // Default to the web_search shape; any future server tool would
  // need its own arm here.
  return {
    type: "web_search_tool_result",
    tool_use_id: toolCallId,
    content: {
      type: "web_search_tool_result_error",
      error_code: "unavailable",
    },
  };
}

/**
 * Render a `web_search_tool_result` block as a markdown summary the
 * model can read in its session log. Citations / encrypted content
 * are dropped here; ACP clients that want them read `display.rawOutput`.
 */
function renderWebSearchResult(block: WebSearchToolResultBlock): {
  text: string;
  isError: boolean;
} {
  const c = block.content;
  if (!Array.isArray(c)) {
    // Error shape: `{ type: "web_search_tool_result_error", error_code }`.
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

/**
 * Render a `web_fetch_tool_result` block as a markdown summary.
 *
 * `WebFetchBlock.content` is a `DocumentBlock` whose `source` is
 * either:
 *   - `PlainTextSource` — the page's extracted text. We pass it
 *     through verbatim (the API already truncates to
 *     `max_content_tokens`).
 *   - `Base64PDFSource` — a fetched PDF. We don't decode it; we
 *     just note the media type and let downstream ACP clients
 *     handle the raw `rawOutput` if they want.
 *
 * Errors include `invalid_tool_input`, `url_not_allowed`,
 * `unsupported_content_type`, etc. — surfaced verbatim.
 */
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
  // c.type === "web_fetch_result" — a WebFetchBlock.
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
    // base64 PDF — don't dump the bytes into the model context.
    lines.push(`[PDF content; ${src.media_type}; see rawOutput for bytes]`);
  }
  return { text: lines.join("\n").trimEnd(), isError: false };
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
