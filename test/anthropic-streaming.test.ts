import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import type { SessionUpdate } from "../src/types/acp.js";

/**
 * The Anthropic harness consumes SSE. We stub `fetch` to return a body
 * built from a hand-crafted event sequence and verify that:
 *   - text deltas are surfaced as agent_message_chunks during streaming
 *   - tool_use input arrives as a complete JSON object after content_block_stop
 *   - stop_reason from message_delta is honored
 */

interface Stream {
  body: ReadableStream<Uint8Array>;
}

function eventStream(events: Array<Record<string, unknown>>): Stream {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = events.map((e) =>
    enc.encode(`event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`),
  );
  return {
    body: new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (const c of chunks) ctrl.enqueue(c);
        ctrl.close();
      },
    }),
  };
}

const realFetch = global.fetch;
let capturedRequest: { url: string; body: unknown } | null = null;

/** Default model-info stub returns a 200000-token context window. */
function modelInfoResponse(modelId: string): Response {
  return new Response(JSON.stringify({ id: modelId, context_window: 200000 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(events: Array<Record<string, unknown>>): void {
  global.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/v1/models/")) {
      const modelId = u.split("/v1/models/")[1] ?? "unknown";
      return modelInfoResponse(modelId);
    }
    capturedRequest = {
      url: u,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    const s = eventStream(events);
    return new Response(s.body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
}

describe("AnthropicHarness streaming", () => {
  beforeEach(() => {
    capturedRequest = null;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("surfaces text deltas as they arrive", async () => {
    stubFetch([
      {
        type: "message_start",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "x",
          usage: { input_tokens: 25, output_tokens: 1 },
        },
      },
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
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 14 },
      },
      { type: "message_stop" },
    ]);

    const agent = await runAgent(
      {
        name: "stream-test",
        tools: {},
        harness: { provider: "anthropic", model: "x" },
      },
      { secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }) },
    );
    try {
      const result = await agent.prompt("hi");
      expect(result.stopReason).toBe("end_turn");
      // Per-turn cumulative usage rides back on the prompt() result.
      expect(result.usage).toMatchObject({ inputTokens: 25, outputTokens: 14 });
      const events = await agent.session.getEvents();
      const chunks = events.filter(
        (e): e is SessionUpdate & { sessionUpdate: "agent_message_chunk" } =>
          e.sessionUpdate === "agent_message_chunk",
      );
      // Two deltas should land as two separate chunks (not one combined).
      expect(chunks).toHaveLength(2);
      const texts = chunks.map((c) =>
        c.content.type === "text" ? c.content.text : "",
      );
      expect(texts).toEqual(["Hello", ", world"]);
      expect(capturedRequest?.body).toMatchObject({ stream: true });
      // A usage_update SessionUpdate should have been emitted with the
      // post-response context size and the model's window from /v1/models/x.
      const usage = events.find((e) => e.sessionUpdate === "usage_update");
      expect(usage).toBeDefined();
      if (usage && usage.sessionUpdate === "usage_update") {
        expect(usage.used).toBe(25 + 14); // input + output
        expect(usage.size).toBe(200000);
      }
    } finally {
      await agent.close();
    }
  });

  it("buffers tool_use input across input_json_delta events", async () => {
    stubFetch([
      { type: "message_start", message: { id: "msg_1", role: "assistant" } },
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
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
      // Second turn: model returns plain text and stops.
    ]);

    // The harness will loop; on the second iteration it asks again. We
    // need the stub to provide a second valid stream that ends the turn.
    let calls = 0;
    global.fetch = (async (_url: string | URL, _init?: RequestInit) => {
      const u = String(_url);
      if (u.includes("/v1/models/")) {
        const modelId = u.split("/v1/models/")[1] ?? "unknown";
        return modelInfoResponse(modelId);
      }
      calls++;
      const events: Array<Record<string, unknown>> =
        calls === 1
          ? [
              {
                type: "message_start",
                message: { id: "m1", role: "assistant" },
              },
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
              { type: "message_delta", delta: { stop_reason: "tool_use" } },
              { type: "message_stop" },
            ]
          : [
              {
                type: "message_start",
                message: { id: "m2", role: "assistant" },
              },
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
              { type: "message_delta", delta: { stop_reason: "end_turn" } },
              { type: "message_stop" },
            ];
      const s = eventStream(events);
      return new Response(s.body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const agent = await runAgent(
      {
        name: "tool-stream",
        tools: { echo: {} },
        harness: { provider: "anthropic", model: "x" },
      },
      { secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }) },
    );
    try {
      const result = await agent.prompt("call echo");
      expect(result.stopReason).toBe("end_turn");
      const events = await agent.session.getEvents();
      const calls = events.filter(
        (e): e is SessionUpdate & { sessionUpdate: "tool_call" } =>
          e.sessionUpdate === "tool_call",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.title).toBe("echo");
      expect(calls[0]?.input).toEqual({ text: "hi" });
    } finally {
      await agent.close();
    }
  });

  it("falls back to non-streaming when stream=false", async () => {
    global.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const u = String(_url);
      if (u.includes("/v1/models/")) {
        const modelId = u.split("/v1/models/")[1] ?? "unknown";
        return modelInfoResponse(modelId);
      }
      capturedRequest = {
        url: u,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      return new Response(
        JSON.stringify({
          id: "msg_1",
          role: "assistant",
          model: "x",
          content: [{ type: "text", text: "non-streamed" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const agent = await runAgent(
      {
        name: "nostream",
        tools: {},
        harness: { provider: "anthropic", model: "x", stream: false },
      },
      { secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }) },
    );
    try {
      const result = await agent.prompt("hi");
      // Body should NOT have stream: true.
      expect(capturedRequest?.body).not.toMatchObject({ stream: true });
      // Usage flows through the non-streaming path too.
      expect(result.usage).toMatchObject({
        inputTokens: 100,
        outputTokens: 5,
      });
      const events = await agent.session.getEvents();
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
