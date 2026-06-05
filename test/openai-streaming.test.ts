import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import { InMemorySession } from "../src/builtins/session/memory.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import type { SessionUpdate } from "../src/types/acp.js";
import { echoTestProvider } from "./fixtures/echo-tool.js";
import { defined } from "./helpers/assert.js";

// The OpenAI harness drives `client.responses.stream(...)`, which consumes a
// Responses-API SSE stream. Each SSE message must carry a JSON `data` payload
// whose `type` field names the event; the SDK rebuilds a Response snapshot from
// `response.created` -> ...deltas... -> `response.completed` and exposes the
// `response.completed` payload (including usage) as `finalResponse()`.
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

function usage(opts: {
  input?: number;
  output?: number;
}): Record<string, unknown> {
  return {
    input_tokens: opts.input ?? 25,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: opts.output ?? 14,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: (opts.input ?? 25) + (opts.output ?? 14),
  };
}

// A minimal Response envelope used by `response.created` / `response.completed`.
function responseEnvelope(opts: {
  status?: string;
  output?: unknown[];
  usage?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    id: "resp_1",
    object: "response",
    created_at: 0,
    model: "x",
    status: opts.status ?? "in_progress",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    output: opts.output ?? [],
    usage: opts.usage ?? null,
    metadata: {},
  };
}

let seq = 0;
function ev(e: Record<string, unknown>): Record<string, unknown> {
  return { sequence_number: seq++, ...e };
}

const realFetch = global.fetch;
let capturedRequest: { url: string; body: unknown } | null = null;

function stubFetchOnce(events: Array<Record<string, unknown>>): void {
  global.fetch = (async (url: string | URL, init?: RequestInit) => {
    capturedRequest = {
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    return streamResponse(events);
  }) as typeof fetch;
}

describe("OpenAIHarness streaming", () => {
  beforeEach(() => {
    capturedRequest = null;
    seq = 0;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("surfaces text deltas as separate chunks and emits usage", async () => {
    const message = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hello, world", annotations: [] }],
    };
    stubFetchOnce([
      ev({ type: "response.created", response: responseEnvelope({}) }),
      ev({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      }),
      ev({
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        item_id: "msg_1",
        part: { type: "output_text", text: "", annotations: [] },
      }),
      ev({
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        item_id: "msg_1",
        delta: "Hello",
      }),
      ev({
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        item_id: "msg_1",
        delta: ", world",
      }),
      ev({
        type: "response.completed",
        response: responseEnvelope({
          status: "completed",
          output: [message],
          usage: usage({ input: 25, output: 14 }),
        }),
      }),
    ]);

    const agent = await runAgent(
      {
        name: "stream-test",
        tools: {},
        harness: { provider: "openai", model: "x" },
        // Plain memory session keeps usage_update events visible in pull().
        session: new InMemorySession(),
      },
      { secrets: new StaticSecretsStore({ OPENAI_API_KEY: "k" }) },
    );
    try {
      const result = await agent.prompt("hi");
      expect(result.stopReason).toBe("end_turn");
      expect(result.usage).toMatchObject({ inputTokens: 25, outputTokens: 14 });
      expect(capturedRequest?.body).toMatchObject({ stream: true });

      const events = (await agent.session.pull?.([])) ?? [];
      const chunks = events.filter(
        (e): e is SessionUpdate & { sessionUpdate: "agent_message_chunk" } =>
          e.sessionUpdate === "agent_message_chunk",
      );
      const texts = chunks.map((c) =>
        c.content.type === "text" ? c.content.text : "",
      );
      // Each delta is surfaced as its own chunk, in order.
      expect(texts).toEqual(["Hello", ", world"]);

      const usageUpdate = defined(
        events.find((e) => e.sessionUpdate === "usage_update"),
      );
      if (usageUpdate.sessionUpdate !== "usage_update")
        throw new Error("unreachable");
      // used = input + output tokens; size is 0 since the harness does not
      // fetch model context-window info.
      expect(usageUpdate.used).toBe(25 + 14);
      expect(usageUpdate.size).toBe(0);
    } finally {
      await agent.close();
    }
  });

  it("buffers streamed tool-call arguments across delta events and parses them", async () => {
    let calls = 0;
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      capturedRequest = {
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      calls++;
      // First turn: stream a function_call whose JSON arguments arrive split
      // across two deltas. Second turn (after the tool result): plain text.
      const events: Array<Record<string, unknown>> =
        calls === 1
          ? [
              ev({ type: "response.created", response: responseEnvelope({}) }),
              ev({
                type: "response.output_item.added",
                output_index: 0,
                item: {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_1",
                  name: "echo",
                  arguments: "",
                  status: "in_progress",
                },
              }),
              ev({
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: "fc_1",
                delta: '{"text":"',
              }),
              ev({
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: "fc_1",
                delta: 'hi"}',
              }),
              ev({
                type: "response.completed",
                response: responseEnvelope({
                  status: "completed",
                  output: [
                    {
                      type: "function_call",
                      id: "fc_1",
                      call_id: "call_1",
                      name: "echo",
                      arguments: '{"text":"hi"}',
                      status: "completed",
                    },
                  ],
                  usage: usage({ input: 25, output: 7 }),
                }),
              }),
            ]
          : [
              ev({ type: "response.created", response: responseEnvelope({}) }),
              ev({
                type: "response.output_item.added",
                output_index: 0,
                item: {
                  type: "message",
                  id: "msg_2",
                  role: "assistant",
                  status: "in_progress",
                  content: [],
                },
              }),
              ev({
                type: "response.content_part.added",
                output_index: 0,
                content_index: 0,
                item_id: "msg_2",
                part: { type: "output_text", text: "", annotations: [] },
              }),
              ev({
                type: "response.output_text.delta",
                output_index: 0,
                content_index: 0,
                item_id: "msg_2",
                delta: "done",
              }),
              ev({
                type: "response.completed",
                response: responseEnvelope({
                  status: "completed",
                  output: [
                    {
                      type: "message",
                      id: "msg_2",
                      role: "assistant",
                      status: "completed",
                      content: [
                        {
                          type: "output_text",
                          text: "done",
                          annotations: [],
                        },
                      ],
                    },
                  ],
                  usage: usage({ input: 30, output: 1 }),
                }),
              }),
            ];
      return streamResponse(events);
    }) as typeof fetch;

    const agent = await runAgent(
      {
        name: "tool-stream",
        tools: { echo: "builtin" },
        capabilities: { echo: "*" },
        harness: { provider: "openai", model: "x" },
      },
      {
        secrets: new StaticSecretsStore({ OPENAI_API_KEY: "k" }),
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
      expect(defined(toolCalls[0]).title).toBe("echo");
      // The split arguments are buffered into the final snapshot and parsed.
      expect(defined(toolCalls[0]).rawInput).toEqual({ text: "hi" });
    } finally {
      await agent.close();
    }
  });
});
