import { describe, expect, it, afterEach } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import { auditAgent } from "../src/audit/audit.js";
import { resolveManifest } from "../src/manifest/resolver.js";
import { anthropicHarnessFactory } from "../src/builtins/harness/anthropic.js";
import { InMemorySession } from "../src/builtins/session/memory.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import { nativeBuiltinNames } from "../src/builtins/tools/native.js";
import type { Harness } from "../src/types/interfaces.js";
import type { SessionUpdate } from "../src/types/acp.js";
import type { AgentManifest } from "../src/types/manifest.js";

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
});

const modelInfoResponse = () =>
  new Response(
    JSON.stringify({
      id: "claude-sonnet-4-5-latest",
      type: "model",
      display_name: "Sonnet",
      created_at: "2024-01-01T00:00:00Z",
      max_input_tokens: 200000,
      max_tokens: 8192,
      capabilities: null,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const usage = (input: number, output: number, serverToolUse: unknown = null) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  server_tool_use: serverToolUse,
  service_tier: "standard",
  cache_creation: null,
  inference_geo: null,
});

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function resolveByName(body: unknown, name: string): Record<string, unknown> | undefined {
  const tools = (body as { tools?: unknown[] } | null)?.tools ?? [];
  return tools.find(
    (t): t is Record<string, unknown> =>
      typeof t === "object" && t !== null && (t as { name?: string }).name === name,
  );
}

type ToolCall = SessionUpdate & { sessionUpdate: "tool_call" };
type ToolCallUpdate = SessionUpdate & { sessionUpdate: "tool_call_update" };

function pull(agent: { session: { pull?: (below: SessionUpdate[]) => Promise<SessionUpdate[]> } }) {
  return agent.session.pull?.([]) ?? Promise.resolve<SessionUpdate[]>([]);
}

const toolCalls = (events: SessionUpdate[]): ToolCall[] =>
  events.filter((e): e is ToolCall => e.sessionUpdate === "tool_call");

const toolCallUpdates = (events: SessionUpdate[]): ToolCallUpdate[] =>
  events.filter((e): e is ToolCallUpdate => e.sessionUpdate === "tool_call_update");

function updateText(update: ToolCallUpdate | undefined): string {
  const first = update?.content?.[0];
  return first?.type === "content" && first.content.type === "text" ? first.content.text : "";
}

const anthropicHarness = (overrides?: Record<string, unknown>) => ({
  provider: "anthropic" as const,
  model: "claude-sonnet-4-5-latest",
  stream: false,
  ...overrides,
});

const anthropicSecrets = () => ({
  secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }),
});

// Standard anthropic agent over an in-memory session; `extra` adds/overrides
// fields like tools, capabilities, or a stubbing session.
const startAgent = (
  name: string,
  extra: Record<string, unknown>,
  harnessOverrides?: Record<string, unknown>,
) =>
  runAgent(
    {
      name,
      harness: anthropicHarness(harnessOverrides),
      session: new InMemorySession(),
      ...extra,
    },
    anthropicSecrets(),
  );

describe("AnthropicHarness server-tool catalog", () => {
  function makeHarness(): Harness {
    return anthropicHarnessFactory.create(
      { model: "claude-sonnet-4-5-latest" },
      {
        manifestDir: process.cwd(),
        agentName: "t",
        loomVersion: "test",
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        storage: "/tmp/loom-test-storage",
        metadata: {},
      },
      { ANTHROPIC_API_KEY: "k" },
    ) as Harness;
  }

  function resolve(h: Harness, name: string) {
    return Promise.resolve(
      h.resolveTool?.(
        name,
        { max_uses: 3 },
        { manifest: {} as never, harness: h, session: {}, systemPromptCore: "" },
        undefined,
      ),
    );
  }

  it("exposes web_search and web_fetch and resolves them to server-side stubs", async () => {
    const h = makeHarness();

    const catalog = (await Promise.resolve(h.availableTools?.())) ?? [];
    const names = catalog.map((r) => r.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");

    const webSearch = await resolve(h, "web_search");
    expect(webSearch?.name).toBe("web_search");
    expect(webSearch?.description).toMatch(/server-side/);

    expect(await resolve(h, "bash")).toBeNull();
  });
});

describe('resolver: provider = "anthropic" routing', () => {
  const resolve = (manifest: AgentManifest) =>
    resolveManifest(manifest, { builtinToolNames: new Set(nativeBuiltinNames()) });

  it("routes opted-in web_search to the (harness) binding with its config", () => {
    const resolved = resolve({
      name: "r",
      harness: { provider: "anthropic" },
      tools: { web_search: { provider: "anthropic", max_uses: 5 } },
    });
    const binding = resolved.tools.find((b) => b.toolName === "web_search");
    expect(binding?.providerInstanceId).toBe("(harness)");
    expect(binding?.toolConfig).toEqual({ max_uses: 5 });
  });

  it("routes opted-in web_fetch to (harness) preserving config", () => {
    const resolved = resolve({
      name: "r",
      harness: { provider: "anthropic" },
      tools: {
        web_fetch: {
          provider: "anthropic",
          max_uses: 2,
          max_content_tokens: 8000,
          allowed_domains: ["example.com"],
        },
      },
    });
    const binding = resolved.tools.find((b) => b.toolName === "web_fetch");
    expect(binding?.providerInstanceId).toBe("(harness)");
    expect(binding?.toolConfig).toEqual({
      max_uses: 2,
      max_content_tokens: 8000,
      allowed_domains: ["example.com"],
    });
  });

  it('fails resolution when provider = "anthropic" on a non-anthropic harness', () => {
    expect(() =>
      resolve({
        name: "r",
        harness: { provider: "openai" },
        tools: { web_search: { provider: "anthropic" } },
      }),
    ).toThrow(/no matching \[providers\] entry or built-in/);
  });

  it("still resolves the Brave web_search via provider = builtin", () => {
    const resolved = resolve({
      name: "r",
      harness: { provider: "anthropic" },
      tools: { web_search: "builtin" },
    });
    const binding = resolved.tools.find((b) => b.toolName === "web_search");
    expect(binding?.providerInstanceId).toBe("native");
  });
});

describe("anthropic web_search end-to-end", () => {
  function stubServerToolResponse(): { body: unknown | null } {
    const captured: { body: unknown | null } = { body: null };
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/v1/models/")) return modelInfoResponse();
      captured.body = init?.body ? JSON.parse(String(init.body)) : null;
      return jsonResponse({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-latest",
        content: [
          {
            type: "server_tool_use",
            id: "srvr_1",
            caller: { type: "direct" },
            name: "web_search",
            input: { query: "what is loom" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvr_1",
            caller: { type: "direct" },
            content: [
              {
                type: "web_search_result",
                title: "Loom — README",
                url: "https://example.com/loom",
                encrypted_content: "<opaque>",
                page_age: "3 days ago",
              },
            ],
          },
          { type: "text", text: "I found a README about Loom.", citations: null },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: usage(100, 20, { web_search_requests: 1 }),
      });
    }) as typeof fetch;
    return captured;
  }

  it("translates [tools] config + [capabilities] grants into web_search_20250305 on the wire", async () => {
    const captured = stubServerToolResponse();
    const agent = await startAgent("ws-e2e", {
      tools: { web_search: { provider: "anthropic", max_uses: 3 } },
      capabilities: { web_search: { allowed_domains: ["docs.python.org"] } },
    });
    try {
      await agent.prompt("search please");
      const webSearch = resolveByName(captured.body, "web_search");
      expect(webSearch).toMatchObject({
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3,
        allowed_domains: ["docs.python.org"],
      });
      expect(webSearch).not.toHaveProperty("input_schema");
      expect(webSearch).not.toHaveProperty("description");
    } finally {
      await agent.close();
    }
  });

  // An empty allowed_domains would mean "search no domains", so an ungranted
  // capability must omit the field entirely rather than send [].
  it("omits allowed_domains on the wire when the capability isn't granted", async () => {
    const captured = stubServerToolResponse();
    const agent = await startAgent("ws-no-cap", { tools: { web_search: "anthropic" } });
    try {
      await agent.prompt("search");
      expect(resolveByName(captured.body, "web_search")?.allowed_domains).toBeUndefined();
    } finally {
      await agent.close();
    }
  });

  it("surfaces server_tool_use + web_search_tool_result as tool_call events", async () => {
    stubServerToolResponse();
    const agent = await startAgent("ws-events", {
      tools: { web_search: { provider: "anthropic" } },
    });
    try {
      const result = await agent.prompt("search please");
      expect(result.stopReason).toBe("end_turn");
      const events = await pull(agent);
      const calls = toolCalls(events);
      const updates = toolCallUpdates(events);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.title).toBe("web_search");
      expect(calls[0]?.toolCallId).toBe("srvr_1");

      expect(updates).toHaveLength(1);
      expect(updates[0]?.toolCallId).toBe("srvr_1");
      expect(updates[0]?.status).toBe("completed");
      const text = updateText(updates[0]);
      expect(text).toContain("Loom — README");
      expect(text).toContain("https://example.com/loom");
    } finally {
      await agent.close();
    }
  });
});

describe("anthropic web_fetch end-to-end", () => {
  function stubFetchResponse(): { body: unknown | null } {
    const captured: { body: unknown | null } = { body: null };
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/v1/models/")) return modelInfoResponse();
      captured.body = init?.body ? JSON.parse(String(init.body)) : null;
      return jsonResponse({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-latest",
        content: [
          {
            type: "server_tool_use",
            id: "srvr_2",
            caller: { type: "direct" },
            name: "web_fetch",
            input: { url: "https://example.com/page" },
          },
          {
            type: "web_fetch_tool_result",
            tool_use_id: "srvr_2",
            caller: { type: "direct" },
            content: {
              type: "web_fetch_result",
              url: "https://example.com/page",
              retrieved_at: "2024-09-01T00:00:00Z",
              content: {
                type: "document",
                title: "Example Page",
                citations: null,
                source: {
                  type: "text",
                  media_type: "text/plain",
                  data: "The full extracted page text.",
                },
              },
            },
          },
          { type: "text", text: "I fetched the page.", citations: null },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: usage(80, 15),
      });
    }) as typeof fetch;
    return captured;
  }

  it("emits web_fetch_20250910 with config (max_uses, max_content_tokens) + capability (allowed_domains)", async () => {
    const captured = stubFetchResponse();
    const agent = await startAgent("wf-e2e", {
      tools: {
        web_fetch: { provider: "anthropic", max_uses: 2, max_content_tokens: 8000 },
      },
      capabilities: { web_fetch: { allowed_domains: ["example.com"] } },
    });
    try {
      await agent.prompt("fetch please");
      expect(resolveByName(captured.body, "web_fetch")).toMatchObject({
        type: "web_fetch_20250910",
        name: "web_fetch",
        max_uses: 2,
        max_content_tokens: 8000,
        allowed_domains: ["example.com"],
      });
    } finally {
      await agent.close();
    }
  });

  // allowed_domains is a capability, not a [tools] config knob, so placing it
  // under [tools] is silently dropped rather than reaching the wire.
  it("does not pass allowed_domains from [tools] config", async () => {
    const captured = stubFetchResponse();
    const agent = await startAgent("wf-misplaced", {
      tools: {
        web_fetch: { provider: "anthropic", allowed_domains: ["misplaced.example.com"] },
      },
    });
    try {
      await agent.prompt("fetch");
      expect(resolveByName(captured.body, "web_fetch")?.allowed_domains).toBeUndefined();
    } finally {
      await agent.close();
    }
  });

  it("renders web_fetch_tool_result text into the tool_call_update content", async () => {
    stubFetchResponse();
    const agent = await startAgent("wf-events", {
      tools: { web_fetch: { provider: "anthropic" } },
    });
    try {
      await agent.prompt("fetch");
      const events = await pull(agent);
      const update = toolCallUpdates(events)[0];
      expect(update?.toolCallId).toBe("srvr_2");
      expect(update?.status).toBe("completed");
      const text = updateText(update);
      expect(text).toContain("Example Page");
      expect(text).toContain("https://example.com/page");
      expect(text).toContain("The full extracted page text.");
    } finally {
      await agent.close();
    }
  });
});

describe("anthropic server-tool event order during streaming", () => {
  // Regression: streamed responses once deferred tool_call / tool_call_update
  // emission until finalMessage() resolved, so tool events landed after the
  // model's full text instead of interleaved where Anthropic produced them.
  it("surfaces server_tool_use + result blocks between surrounding text deltas", async () => {
    const enc = new TextEncoder();
    const sseFrame = (e: Record<string, unknown>): Uint8Array =>
      enc.encode(`event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`);
    const eventSequence: Record<string, unknown>[] = [
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-latest",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: usage(10, 0),
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Let me search." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "server_tool_use",
          id: "srvr_1",
          caller: { type: "direct" },
          name: "web_search",
          input: { query: "loom" },
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "" },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "srvr_1",
          caller: { type: "direct" },
          content: [
            {
              type: "web_search_result",
              title: "Loom",
              url: "https://example.com/loom",
              encrypted_content: "ENC",
            },
          ],
        },
      },
      { type: "content_block_stop", index: 2 },
      { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 3,
        delta: { type: "text_delta", text: "Found the README." },
      },
      { type: "content_block_stop", index: 3 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 15 },
      },
      { type: "message_stop" },
    ];
    global.fetch = (async (url: string | URL) => {
      if (String(url).includes("/v1/models/")) return modelInfoResponse();
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          for (const e of eventSequence) ctrl.enqueue(sseFrame(e));
          ctrl.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const agent = await startAgent(
      "streaming-order",
      { tools: { web_search: "anthropic" } },
      { stream: true },
    );
    try {
      await agent.prompt("search please");
      const events = await pull(agent);
      const sequenceKinds = events
        .map((e) => e.sessionUpdate)
        .filter(
          (k) =>
            k === "agent_message_chunk" || k === "tool_call" || k === "tool_call_update",
        );
      expect(sequenceKinds).toEqual([
        "agent_message_chunk",
        "tool_call",
        "tool_call_update",
        "agent_message_chunk",
      ]);
    } finally {
      await agent.close();
    }
  });
});

describe("anthropic server-tool replay within a session", () => {
  it("re-sends server_tool_use + web_search_tool_result on a second turn", async () => {
    const captured: { bodies: unknown[] } = { bodies: [] };
    let turn = 0;
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/v1/models/")) return modelInfoResponse();
      captured.bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      turn += 1;
      return jsonResponse(
        turn === 1
          ? {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-5-latest",
              content: [
                {
                  type: "server_tool_use",
                  id: "srvr_1",
                  caller: { type: "direct" },
                  name: "web_search",
                  input: { query: "loom" },
                },
                {
                  type: "web_search_tool_result",
                  tool_use_id: "srvr_1",
                  caller: { type: "direct" },
                  content: [
                    {
                      type: "web_search_result",
                      title: "Loom — README",
                      url: "https://example.com/loom",
                      encrypted_content: "ENC-XYZ-123",
                      page_age: "3 days ago",
                    },
                  ],
                },
                { type: "text", text: "I found a README about Loom.", citations: null },
              ],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: usage(100, 20, { web_search_requests: 1 }),
            }
          : {
              id: "msg_2",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-5-latest",
              content: [
                { type: "text", text: "Building on the search above…", citations: null },
              ],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: usage(150, 8),
            },
      );
    }) as typeof fetch;

    const agent = await startAgent("replay", {
      tools: { web_search: { provider: "anthropic" } },
    });
    try {
      await agent.prompt("search please");
      await agent.prompt("now tell me more");
      expect(captured.bodies).toHaveLength(2);
      const second = captured.bodies[1] as { messages?: unknown[] };
      const assistant = (second.messages ?? []).find(
        (m): m is { role: string; content: unknown[] } =>
          typeof m === "object" && m !== null && (m as { role?: string }).role === "assistant",
      );
      const content = (assistant?.content ?? []) as Array<{
        type: string;
        id?: string;
        name?: string;
        tool_use_id?: string;
        content?: unknown;
      }>;
      expect(content.find((c) => c.type === "server_tool_use")).toMatchObject({
        type: "server_tool_use",
        id: "srvr_1",
        name: "web_search",
      });
      const serverResult = content.find((c) => c.type === "web_search_tool_result");
      expect(serverResult).toMatchObject({
        type: "web_search_tool_result",
        tool_use_id: "srvr_1",
      });
      const results = (serverResult?.content ?? []) as Array<{ encrypted_content?: string }>;
      expect(results[0]?.encrypted_content).toBe("ENC-XYZ-123");
    } finally {
      await agent.close();
    }
  });

  it("falls back to an `unavailable` placeholder when rawOutput is missing", async () => {
    const captured: { bodies: unknown[] } = { bodies: [] };
    let turn = 0;
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/v1/models/")) return modelInfoResponse();
      captured.bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      turn += 1;
      return jsonResponse(
        turn === 1
          ? {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-5-latest",
              content: [
                {
                  type: "server_tool_use",
                  id: "srvr_x",
                  caller: { type: "direct" },
                  name: "web_search",
                  input: { query: "loom" },
                },
                {
                  type: "web_search_tool_result",
                  tool_use_id: "srvr_x",
                  caller: { type: "direct" },
                  content: [
                    {
                      type: "web_search_result",
                      title: "Loom",
                      url: "https://example.com",
                      encrypted_content: "WILL-BE-STRIPPED",
                    },
                  ],
                },
                { type: "text", text: "searched.", citations: null },
              ],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: usage(10, 5, { web_search_requests: 1 }),
            }
          : {
              id: "msg_2",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-5-latest",
              content: [{ type: "text", text: "ok", citations: null }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: usage(10, 1),
            },
      );
    }) as typeof fetch;

    const stripping = new InMemorySession();
    const origPush = stripping.push?.bind(stripping);
    stripping.push = async (event) => {
      if (event.sessionUpdate === "tool_call_update") {
        const stripped: typeof event = { ...event };
        delete (stripped as { rawOutput?: unknown }).rawOutput;
        return origPush ? origPush(stripped) : [];
      }
      return origPush ? origPush(event) : [];
    };

    const agent = await runAgent(
      {
        name: "unavailable",
        harness: anthropicHarness(),
        session: stripping,
        tools: { web_search: { provider: "anthropic" } },
      },
      anthropicSecrets(),
    );
    try {
      await agent.prompt("search");
      await agent.prompt("continue");
      const second = captured.bodies[1] as { messages?: unknown[] };
      const assistant = (second.messages ?? []).find(
        (m): m is { role: string; content: unknown[] } =>
          typeof m === "object" && m !== null && (m as { role?: string }).role === "assistant",
      );
      const content = (assistant?.content ?? []) as Array<{
        type: string;
        content?: { type?: string; error_code?: string };
      }>;
      expect(content.find((c) => c.type === "web_search_tool_result")?.content).toMatchObject({
        type: "web_search_tool_result_error",
        error_code: "unavailable",
      });
    } finally {
      await agent.close();
    }
  });
});

describe("audit: harness availableTools surfaces in summary", () => {
  it("lists the catalog on the harness summary", async () => {
    const tree = await auditAgent({
      name: "audit-ws",
      harness: { provider: "anthropic" },
      tools: { web_search: { provider: "anthropic" } },
    });
    expect(tree.harness.availableTools).toContain("web_search");
    expect(tree.harness.availableTools).toContain("web_fetch");
  });
});
