import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import { InMemorySession } from "../src/builtins/session/memory.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import type { SessionUpdate } from "../src/types/acp.js";
import { echoTestProvider } from "./fixtures/echo-tool.js";

function eventStream(
  events: Array<Record<string, unknown>>,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const chunks = events.map((e) =>
    enc.encode(`event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`),
  );
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(c);
      ctrl.close();
    },
  });
}

function streamResponse(events: Array<Record<string, unknown>>): Response {
  return new Response(eventStream(events), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// The SDK's content-block assembler requires the full Message envelope here.
function messageStart(opts: {
  id?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}): Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      id: opts.id ?? "msg_1",
      type: "message",
      role: "assistant",
      model: opts.model ?? "x",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: opts.inputTokens ?? 25,
        output_tokens: opts.outputTokens ?? 1,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        server_tool_use: null,
        service_tier: "standard",
        cache_creation: null,
        inference_geo: null,
      },
    },
  };
}

function messageBody(opts: {
  id?: string;
  model?: string;
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
}): Record<string, unknown> {
  return {
    id: opts.id ?? "msg_1",
    type: "message",
    role: "assistant",
    model: opts.model ?? "x",
    content: opts.text ? [{ type: "text", text: opts.text }] : [],
    stop_reason: opts.stopReason ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: opts.inputTokens ?? 25,
      output_tokens: opts.outputTokens ?? 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: "standard",
      cache_creation: null,
      inference_geo: null,
    },
  };
}

const realFetch = global.fetch;
let capturedRequest: { url: string; body: unknown } | null = null;

function modelInfoResponse(modelId: string): Response {
  return new Response(
    JSON.stringify({
      id: modelId,
      type: "model",
      display_name: modelId,
      created_at: "2024-01-01T00:00:00Z",
      max_input_tokens: 200000,
      max_tokens: 8192,
      capabilities: null,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function modelIdFromUrl(url: string): string {
  return url.split("/v1/models/")[1] ?? "unknown";
}

function stubFetch(events: Array<Record<string, unknown>>): void {
  global.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/v1/models/")) return modelInfoResponse(modelIdFromUrl(u));
    capturedRequest = {
      url: u,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    return streamResponse(events);
  }) as typeof fetch;
}

describe("AnthropicHarness streaming", () => {
  beforeEach(() => {
    capturedRequest = null;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("surfaces text deltas as separate chunks and emits usage", async () => {
    stubFetch([
      messageStart({ inputTokens: 25, outputTokens: 1 }),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: ", world" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 14 },
      },
      { type: "message_stop" },
    ]);

    const agent = await runAgent(
      {
        name: "stream-test",
        tools: {},
        harness: { provider: "anthropic", model: "x" },
        // Plain memory session keeps usage_update events visible in pull().
        session: new InMemorySession(),
      },
      { secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }) },
    );
    try {
      const result = await agent.prompt("hi");
      expect(result.stopReason).toBe("end_turn");
      expect(result.usage).toMatchObject({ inputTokens: 25, outputTokens: 14 });
      expect(capturedRequest?.body).toMatchObject({ stream: true });
      // Automatic prompt caching: a top-level ephemeral breakpoint must be
      // sent or every turn re-bills the full prompt.
      expect(capturedRequest?.body).toMatchObject({
        cache_control: { type: "ephemeral" },
      });

      const events = (await agent.session.pull?.([])) ?? [];
      const chunks = events.filter(
        (e): e is SessionUpdate & { sessionUpdate: "agent_message_chunk" } =>
          e.sessionUpdate === "agent_message_chunk",
      );
      const texts = chunks.map((c) =>
        c.content.type === "text" ? c.content.text : "",
      );
      expect(texts).toEqual(["Hello", ", world"]);

      const usage = events.find((e) => e.sessionUpdate === "usage_update");
      expect(usage).toBeDefined();
      if (usage && usage.sessionUpdate === "usage_update") {
        expect(usage.used).toBe(25 + 14);
        expect(usage.size).toBe(200000);
      }
    } finally {
      await agent.close();
    }
  });

  it("buffers tool_use input across input_json_delta events", async () => {
    let calls = 0;
    global.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/v1/models/")) return modelInfoResponse(modelIdFromUrl(u));
      calls++;
      const events: Array<Record<string, unknown>> =
        calls === 1
          ? [
              messageStart({ id: "m1" }),
              {
                type: "content_block_start",
                index: 0,
                content_block: {
                  type: "tool_use",
                  id: "toolu_1",
                  name: "echo",
                  input: {},
                },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json: '{"text":"' },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json: 'hi"}' },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "tool_use", stop_sequence: null },
                usage: { output_tokens: 7 },
              },
              { type: "message_stop" },
            ]
          : [
              messageStart({ id: "m2" }),
              {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "done" },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 1 },
              },
              { type: "message_stop" },
            ];
      return streamResponse(events);
    }) as typeof fetch;

    const agent = await runAgent(
      {
        name: "tool-stream",
        tools: { echo: "builtin" },
        capabilities: { echo: "*" },
        harness: { provider: "anthropic", model: "x" },
      },
      {
        secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }),
        providers: [echoTestProvider],
      },
    );
    try {
      const result = await agent.prompt("call echo");
      expect(result.stopReason).toBe("end_turn");
      const events = (await agent.session.pull?.([])) ?? [];
      const toolCalls = events.filter(
        (e): e is SessionUpdate & { sessionUpdate: "tool_call" } =>
          e.sessionUpdate === "tool_call",
      );
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]?.title).toBe("echo");
      expect(toolCalls[0]?.rawInput).toEqual({ text: "hi" });
    } finally {
      await agent.close();
    }
  });

  it("falls back to non-streaming when stream=false", async () => {
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v1/models/")) return modelInfoResponse(modelIdFromUrl(u));
      capturedRequest = {
        url: u,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      return new Response(
        JSON.stringify(
          messageBody({
            id: "msg_1",
            text: "non-streamed",
            inputTokens: 100,
            outputTokens: 5,
          }),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const agent = await runAgent(
      {
        name: "nostream",
        tools: {},
        harness: { provider: "anthropic", model: "x", stream: false },
        session: new InMemorySession(),
      },
      { secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }) },
    );
    try {
      const result = await agent.prompt("hi");
      expect(capturedRequest?.body).not.toMatchObject({ stream: true });
      expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 5 });

      const events = (await agent.session.pull?.([])) ?? [];
      const text = events.find(
        (e) => e.sessionUpdate === "agent_message_chunk",
      );
      if (
        text?.sessionUpdate === "agent_message_chunk" &&
        text.content.type === "text"
      ) {
        expect(text.content.text).toBe("non-streamed");
      } else {
        throw new Error("expected agent text");
      }

      const usage = events.find((e) => e.sessionUpdate === "usage_update");
      expect(usage).toBeDefined();
      if (usage && usage.sessionUpdate === "usage_update") {
        expect(usage.used).toBe(105);
        expect(usage.size).toBe(200000);
      }
    } finally {
      await agent.close();
    }
  });
});
