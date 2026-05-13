/**
 * Tests for harness-exposed server tools.
 *
 * Covers:
 *   - `AnthropicHarness.availableTools()` returns the catalog.
 *   - Resolver routes `[tools.web_search] provider = "anthropic"` to
 *     the synthetic `(harness)` instance.
 *   - End-to-end: a manifest opting in via `provider = "anthropic"`
 *     boots successfully; the API request body carries the native
 *     `web_search_20250305` server-tool shape (not a regular `tool`).
 *   - Server-tool config (max_uses / allowed_domains) flows from
 *     `[tools.web_search]` into the API tool descriptor.
 *   - `server_tool_use` + `web_search_tool_result` blocks in a
 *     response surface as `tool_call` + `tool_call_update` events
 *     without dispatching through ToolTable.
 *   - The Brave-based `web_search` (provider="builtin") still works
 *     alongside the harness route \u2014 the two are mutually
 *     exclusive per manifest.
 *   - Audit surfaces `availableTools` on the harness summary.
 */

import { describe, expect, it, afterEach } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import { auditAgent } from "../src/audit/audit.js";
import { resolveManifest } from "../src/manifest/resolver.js";
import { anthropicHarnessFactory } from "../src/builtins/harness/anthropic.js";
import { InMemorySession } from "../src/builtins/session/memory.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import { nativeBuiltinNames } from "../src/builtins/tools/native.js";
import type { Harness, SessionFactory } from "../src/types/interfaces.js";
import type { SessionUpdate } from "../src/types/acp.js";

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
});

// ─── Harness-direct tests ────────────────────────────────────────────────

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
      },
      { ANTHROPIC_API_KEY: "k" },
    ) as Harness;
  }

  it("availableTools() exposes web_search and web_fetch", async () => {
    const h = makeHarness();
    const catalog = await Promise.resolve(h.availableTools?.());
    expect(catalog).toBeDefined();
    const names = (catalog ?? []).map((r) => r.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
  });

  it("resolveTool('web_search') returns a stub Tool", async () => {
    const h = makeHarness();
    const tool = await Promise.resolve(
      h.resolveTool?.(
        "web_search",
        { max_uses: 3 },
        // The stub doesn't read `agent` or capabilities; pass minimal.
        {
          manifest: {} as never,
          harness: h,
          session: {},
          systemPromptCore: "",
        },
        undefined,
      ),
    );
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("web_search");
    expect(tool?.description).toMatch(/server-side/);
  });

  it("resolveTool returns null for unknown names", async () => {
    const h = makeHarness();
    const tool = await Promise.resolve(
      h.resolveTool?.(
        "bash",
        {},
        {
          manifest: {} as never,
          harness: h,
          session: {},
          systemPromptCore: "",
        },
        undefined,
      ),
    );
    expect(tool).toBeNull();
  });
});

// ─── Resolver routing ────────────────────────────────────────────────────

describe('resolver: provider = "anthropic" routes to (harness)', () => {
  it("emits a (harness) binding when the tool name is opted in", () => {
    const resolved = resolveManifest(
      {
        name: "r",
        harness: { provider: "anthropic" },
        tools: {
          web_search: { provider: "anthropic", max_uses: 5 },
        },
      },
      { builtinToolNames: new Set(nativeBuiltinNames()) },
    );
    const binding = resolved.tools.find((b) => b.toolName === "web_search");
    expect(binding).toBeDefined();
    expect(binding?.providerInstanceId).toBe("(harness)");
    expect(binding?.toolConfig).toEqual({ max_uses: 5 });
  });

  it('`provider = "anthropic"` on a non-anthropic harness fails resolution', () => {
    expect(() =>
      resolveManifest(
        {
          name: "r",
          harness: { provider: "openai" },
          tools: { web_search: { provider: "anthropic" } },
        },
        { builtinToolNames: new Set(nativeBuiltinNames()) },
      ),
    ).toThrow(/no matching \[providers\] entry or built-in/);
  });

  it('the Brave web_search (provider = "builtin") still resolves', () => {
    const resolved = resolveManifest(
      {
        name: "r",
        harness: { provider: "anthropic" },
        tools: { web_search: "builtin" },
      },
      { builtinToolNames: new Set(nativeBuiltinNames()) },
    );
    const binding = resolved.tools.find((b) => b.toolName === "web_search");
    expect(binding?.providerInstanceId).toBe("native");
  });
});

// ─── web_fetch routing ──────────────────────────────────────────────────

describe("resolver + harness: web_fetch", () => {
  it('routes provider = "anthropic" for web_fetch to (harness)', () => {
    const resolved = resolveManifest(
      {
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
      },
      { builtinToolNames: new Set(nativeBuiltinNames()) },
    );
    const binding = resolved.tools.find((b) => b.toolName === "web_fetch");
    expect(binding?.providerInstanceId).toBe("(harness)");
    expect(binding?.toolConfig).toEqual({
      max_uses: 2,
      max_content_tokens: 8000,
      allowed_domains: ["example.com"],
    });
  });
});

// ─── End-to-end via runAgent ────────────────────────────────────

/**
 * Minimal in-memory session factory used by these tests so we can read
 * back `tool_call_update` content without the compacting layer
 * dropping them.
 */
const inMemSessionFactory: SessionFactory = {
  name: "in-memory",
  create: () => new InMemorySession(),
};

describe("anthropic web_search end-to-end", () => {
  function stubAnthropicWithServerToolResponse(): { body: unknown | null } {
    const captured: { body: unknown | null } = { body: null };
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v1/models/")) {
        return new Response(
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
      }
      captured.body = init?.body ? JSON.parse(String(init.body)) : null;
      // A non-streaming Message body containing a server_tool_use
      // + web_search_tool_result + a final text block.
      const body = {
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
                title: "Loom \u2014 README",
                url: "https://example.com/loom",
                encrypted_content: "<opaque>",
                page_age: "3 days ago",
              },
            ],
          },
          {
            type: "text",
            text: "I found a README about Loom.",
            citations: null,
          },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: { web_search_requests: 1 },
          service_tier: "standard",
          cache_creation: null,
          inference_geo: null,
        },
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return captured;
  }

  it("translates [tools] config + [capabilities] grants into web_search_20250305 on the wire", async () => {
    const captured = stubAnthropicWithServerToolResponse();
    const agent = await runAgent(
      {
        name: "ws-e2e",
        harness: {
          provider: "anthropic",
          model: "claude-sonnet-4-5-latest",
          stream: false,
        },
        session: new InMemorySession(),
        tools: {
          web_search: { provider: "anthropic", max_uses: 3 },
        },
        capabilities: {
          web_search: { allowed_domains: ["docs.python.org"] },
        },
      },
      { secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }) },
    );
    try {
      await agent.prompt("search please");
      const body = captured.body as { tools?: unknown[] } | null;
      expect(body).toBeTruthy();
      expect(body?.tools).toBeDefined();
      const webSearch = (body?.tools ?? []).find(
        (t: unknown) =>
          typeof t === "object" &&
          t !== null &&
          (t as { name?: string }).name === "web_search",
      );
      // Config (max_uses) lands on the API descriptor:
      expect(webSearch).toMatchObject({
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3,
      });
      // Capability (allowed_domains) lands on the API descriptor:
      expect(webSearch).toMatchObject({
        allowed_domains: ["docs.python.org"],
      });
      // Regular `Tool` shape (name + description + input_schema)
      // shouldn't leak in for harness-exposed tools.
      expect(webSearch).not.toHaveProperty("input_schema");
      expect(webSearch).not.toHaveProperty("description");
    } finally {
      await agent.close();
    }
  });

  it("omits allowed_domains on the wire when the capability isn't granted", async () => {
    // No `[capabilities]` block at all — the tool runs unrestricted
    // (Anthropic's default of "any domain"). The API descriptor must
    // NOT include an empty `allowed_domains: []` (that would mean
    // "search no domains"), only omit the field.
    const captured = stubAnthropicWithServerToolResponse();
    const agent = await runAgent(
      {
        name: "ws-no-cap",
        harness: {
          provider: "anthropic",
          model: "claude-sonnet-4-5-latest",
          stream: false,
        },
        session: new InMemorySession(),
        tools: { web_search: "anthropic" }, // string shorthand
      },
      { secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }) },
    );
    try {
      await agent.prompt("search");
      const body = captured.body as { tools?: unknown[] } | null;
      const webSearch = (body?.tools ?? []).find(
        (t: unknown) =>
          typeof t === "object" &&
          t !== null &&
          (t as { name?: string }).name === "web_search",
      ) as { allowed_domains?: unknown } | undefined;
      expect(webSearch?.allowed_domains).toBeUndefined();
    } finally {
      await agent.close();
    }
  });

  it("surfaces server_tool_use + web_search_tool_result as tool_call events", async () => {
    stubAnthropicWithServerToolResponse();
    const agent = await runAgent(
      {
        name: "ws-events",
        harness: {
          provider: "anthropic",
          model: "claude-sonnet-4-5-latest",
          stream: false,
        },
        session: new InMemorySession(),
        tools: { web_search: { provider: "anthropic" } },
      },
      { secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }) },
    );
    try {
      const result = await agent.prompt("search please");
      expect(result.stopReason).toBe("end_turn");
      const events = (await agent.session.pull?.([])) ?? [];
      const calls = events.filter(
        (e): e is SessionUpdate & { sessionUpdate: "tool_call" } =>
          e.sessionUpdate === "tool_call",
      );
      const updates = events.filter(
        (e): e is SessionUpdate & { sessionUpdate: "tool_call_update" } =>
          e.sessionUpdate === "tool_call_update",
      );
      // One server tool call surfaced as tool_call with title=web_search.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.title).toBe("web_search");
      expect(calls[0]?.toolCallId).toBe("srvr_1");
      // Paired update with completion status + rendered text.
      expect(updates).toHaveLength(1);
      expect(updates[0]?.toolCallId).toBe("srvr_1");
      expect(updates[0]?.status).toBe("completed");
      const text =
        updates[0]?.content?.[0]?.type === "content" &&
        updates[0]?.content[0]?.content.type === "text"
          ? updates[0]?.content[0]?.content.text
          : "";
      expect(text).toContain("Loom \u2014 README");
      expect(text).toContain("https://example.com/loom");
    } finally {
      await agent.close();
    }
  });
});

// ─── web_fetch end-to-end ──────────────────────────────────────────────

describe("anthropic web_fetch end-to-end", () => {
  function stubAnthropicWithFetchResponse(): { body: unknown | null } {
    const captured: { body: unknown | null } = { body: null };
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v1/models/")) {
        return new Response(
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
      }
      captured.body = init?.body ? JSON.parse(String(init.body)) : null;
      const body = {
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
        usage: {
          input_tokens: 80,
          output_tokens: 15,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: "standard",
          cache_creation: null,
          inference_geo: null,
        },
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return captured;
  }

  it("emits web_fetch_20250910 with config (max_uses, max_content_tokens) + capability (allowed_domains)", async () => {
    const captured = stubAnthropicWithFetchResponse();
    const agent = await runAgent(
      {
        name: "wf-e2e",
        harness: {
          provider: "anthropic",
          model: "claude-sonnet-4-5-latest",
          stream: false,
        },
        session: new InMemorySession(),
        tools: {
          web_fetch: {
            provider: "anthropic",
            max_uses: 2,
            max_content_tokens: 8000,
          },
        },
        capabilities: {
          web_fetch: { allowed_domains: ["example.com"] },
        },
      },
      { secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }) },
    );
    try {
      await agent.prompt("fetch please");
      const body = captured.body as { tools?: unknown[] } | null;
      const fetchTool = (body?.tools ?? []).find(
        (t: unknown) =>
          typeof t === "object" &&
          t !== null &&
          (t as { name?: string }).name === "web_fetch",
      );
      // Config knobs land on the API descriptor:
      expect(fetchTool).toMatchObject({
        type: "web_fetch_20250910",
        name: "web_fetch",
        max_uses: 2,
        max_content_tokens: 8000,
      });
      // The capability grant flows through `[capabilities]`, not
      // `[tools]`, and lands on the API descriptor's allow-list:
      expect(fetchTool).toMatchObject({
        allowed_domains: ["example.com"],
      });
    } finally {
      await agent.close();
    }
  });

  it("does not pass allowed_domains from [tools] config (it must come from [capabilities])", async () => {
    // Putting `allowed_domains` in `[tools]` config is silently
    // ignored — it's not a config knob, it's a capability. The user
    // should move it to `[capabilities]`; the resolver doesn't error
    // because `assertKnownKinds` only checks the capability side.
    const captured = stubAnthropicWithFetchResponse();
    const agent = await runAgent(
      {
        name: "wf-misplaced",
        harness: {
          provider: "anthropic",
          model: "claude-sonnet-4-5-latest",
          stream: false,
        },
        session: new InMemorySession(),
        tools: {
          web_fetch: {
            provider: "anthropic",
            allowed_domains: ["misplaced.example.com"],
          },
        },
      },
      { secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }) },
    );
    try {
      await agent.prompt("fetch");
      const body = captured.body as { tools?: unknown[] } | null;
      const fetchTool = (body?.tools ?? []).find(
        (t: unknown) =>
          typeof t === "object" &&
          t !== null &&
          (t as { name?: string }).name === "web_fetch",
      ) as { allowed_domains?: unknown } | undefined;
      expect(fetchTool?.allowed_domains).toBeUndefined();
    } finally {
      await agent.close();
    }
  });

  it("renders web_fetch_tool_result text into the tool_call_update content", async () => {
    stubAnthropicWithFetchResponse();
    const agent = await runAgent(
      {
        name: "wf-events",
        harness: {
          provider: "anthropic",
          model: "claude-sonnet-4-5-latest",
          stream: false,
        },
        session: new InMemorySession(),
        tools: { web_fetch: { provider: "anthropic" } },
      },
      { secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }) },
    );
    try {
      await agent.prompt("fetch");
      const events = (await agent.session.pull?.([])) ?? [];
      const update = events.find(
        (e): e is SessionUpdate & { sessionUpdate: "tool_call_update" } =>
          e.sessionUpdate === "tool_call_update",
      );
      expect(update?.toolCallId).toBe("srvr_2");
      expect(update?.status).toBe("completed");
      const text =
        update?.content?.[0]?.type === "content" &&
        update?.content[0]?.content.type === "text"
          ? update?.content[0]?.content.text
          : "";
      expect(text).toContain("Example Page");
      expect(text).toContain("https://example.com/page");
      expect(text).toContain("The full extracted page text.");
    } finally {
      await agent.close();
    }
  });
});

// ─── In-session replay (encrypted content survives across turns) ─────────────

describe("anthropic server-tool replay within a session", () => {
  it("re-sends server_tool_use + web_search_tool_result on a second turn", async () => {
    // Two consecutive prompts. The first turn's response contains a
    // server_tool_use + web_search_tool_result + text; the second
    // turn's response is text-only. We capture both request bodies
    // and assert the second one includes the full server-tool pair
    // (with encrypted_content intact) in the assistant history.
    const captured: { bodies: unknown[] } = { bodies: [] };
    let turn = 0;
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v1/models/")) {
        return new Response(
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
      }
      captured.bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      turn += 1;
      const body =
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
                {
                  type: "text",
                  text: "I found a README about Loom.",
                  citations: null,
                },
              ],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: {
                input_tokens: 100,
                output_tokens: 20,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                server_tool_use: { web_search_requests: 1 },
                service_tier: "standard",
                cache_creation: null,
                inference_geo: null,
              },
            }
          : {
              id: "msg_2",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-5-latest",
              content: [
                {
                  type: "text",
                  text: "Building on the search above…",
                  citations: null,
                },
              ],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: {
                input_tokens: 150,
                output_tokens: 8,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                server_tool_use: null,
                service_tier: "standard",
                cache_creation: null,
                inference_geo: null,
              },
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const agent = await runAgent(
      {
        name: "replay",
        harness: {
          provider: "anthropic",
          model: "claude-sonnet-4-5-latest",
          stream: false,
        },
        session: new InMemorySession(),
        tools: { web_search: { provider: "anthropic" } },
      },
      { secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }) },
    );
    try {
      await agent.prompt("search please");
      await agent.prompt("now tell me more");
      expect(captured.bodies).toHaveLength(2);
      const second = captured.bodies[1] as { messages?: unknown[] };
      expect(second?.messages).toBeDefined();
      // The assistant message reconstructed from the first turn must
      // contain BOTH the server_tool_use AND web_search_tool_result
      // blocks — inline, in the assistant message (not split off into
      // a synthesised user tool_result).
      const assistant = (second.messages ?? []).find(
        (m): m is { role: string; content: unknown[] } =>
          typeof m === "object" &&
          m !== null &&
          (m as { role?: string }).role === "assistant",
      );
      expect(assistant).toBeDefined();
      const content = (assistant?.content ?? []) as Array<{
        type: string;
        id?: string;
        name?: string;
        tool_use_id?: string;
        content?: unknown;
      }>;
      const serverUse = content.find((c) => c.type === "server_tool_use");
      const serverResult = content.find(
        (c) => c.type === "web_search_tool_result",
      );
      expect(serverUse).toMatchObject({
        type: "server_tool_use",
        id: "srvr_1",
        name: "web_search",
      });
      expect(serverResult).toMatchObject({
        type: "web_search_tool_result",
        tool_use_id: "srvr_1",
      });
      // The critical assertion: encrypted_content survived the
      // round-trip via session-stored rawOutput.
      const results = (serverResult?.content ?? []) as Array<{
        encrypted_content?: string;
      }>;
      expect(results[0]?.encrypted_content).toBe("ENC-XYZ-123");
    } finally {
      await agent.close();
    }
  });

  it("falls back to an `unavailable` placeholder when rawOutput is missing", async () => {
    // Same two-prompt setup, but a transformer session strips
    // rawOutput from tool_call_update events before the second turn.
    // The harness should still emit a server_tool_use + result pair
    // (not drop the call), with the result block being the
    // `error_code: "unavailable"` variant.
    const captured: { bodies: unknown[] } = { bodies: [] };
    let turn = 0;
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v1/models/")) {
        return new Response(
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
      }
      captured.bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      turn += 1;
      const body =
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
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                server_tool_use: { web_search_requests: 1 },
                service_tier: "standard",
                cache_creation: null,
                inference_geo: null,
              },
            }
          : {
              id: "msg_2",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-5-latest",
              content: [{ type: "text", text: "ok", citations: null }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: {
                input_tokens: 10,
                output_tokens: 1,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                server_tool_use: null,
                service_tier: "standard",
                cache_creation: null,
                inference_geo: null,
              },
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    // Session that strips rawOutput from tool_call_update events to
    // simulate compaction / cross-process resume.
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
        harness: {
          provider: "anthropic",
          model: "claude-sonnet-4-5-latest",
          stream: false,
        },
        session: stripping,
        tools: { web_search: { provider: "anthropic" } },
      },
      { secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }) },
    );
    try {
      await agent.prompt("search");
      await agent.prompt("continue");
      const second = captured.bodies[1] as { messages?: unknown[] };
      const assistant = (second.messages ?? []).find(
        (m): m is { role: string; content: unknown[] } =>
          typeof m === "object" &&
          m !== null &&
          (m as { role?: string }).role === "assistant",
      );
      const content = (assistant?.content ?? []) as Array<{
        type: string;
        content?: { type?: string; error_code?: string };
      }>;
      const result = content.find((c) => c.type === "web_search_tool_result");
      expect(result?.content).toMatchObject({
        type: "web_search_tool_result_error",
        error_code: "unavailable",
      });
    } finally {
      await agent.close();
    }
  });
});

// ─── Audit surfaces availableTools ──────────────────────────────────

describe("audit: harness availableTools surfaces in summary", () => {
  it("lists the catalog on the harness summary", async () => {
    const tree = await auditAgent({
      name: "audit-ws",
      harness: { provider: "anthropic" },
      tools: { web_search: { provider: "anthropic" } },
    });
    expect(tree.harness.availableTools).toBeDefined();
    expect(tree.harness.availableTools).toContain("web_search");
    expect(tree.harness.availableTools).toContain("web_fetch");
  });
});

// `inMemSessionFactory` kept around in case future tests want it; we
// currently use `new InMemorySession()` directly via the pre-built
// session-instance manifest shape.
void inMemSessionFactory;
