/**
 * End-to-end plumbing tests for image content blocks in tool results:
 *
 *   - runtime `emitToolResult`: block arrays map 1:1 to `{type:"content"}`
 *     entries in the session's tool_call_update; strings stay a single
 *     text entry (the historical shape).
 *   - anthropic events→messages converter: text-only results keep the
 *     plain-string tool_result content (byte-identical requests preserve
 *     prompt caches); results with an image become an API block array.
 *   - openai converter and the test harness's surfaced output flatten
 *     image entries to a `[image: <mimeType>]` placeholder.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import { InMemorySession } from "../src/builtins/session/memory.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import type { SessionUpdate } from "../src/types/acp.js";
import type {
  Agent,
  Tool,
  ToolConfig,
  ToolContext,
  ToolResult,
  Tools,
} from "../src/types/interfaces.js";
import type { CapabilitySet } from "../src/types/manifest.js";
import { defined } from "./helpers/assert.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Test tool returning mixed text + image blocks (with an empty trailing text). */
class SnapshotTool implements Tool {
  public readonly name = "snapshot";
  public readonly description = "Return a screenshot. Test-only.";
  public readonly inputSchema = { type: "object" as const };
  public readonly capabilities: CapabilitySet;

  constructor(_config: ToolConfig, capabilities: CapabilitySet | undefined) {
    this.capabilities = capabilities ?? {};
  }

  async execute(_input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    return {
      content: [
        { type: "text", text: "before " },
        { type: "text", text: "and after" },
        { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        { type: "text", text: "" },
      ],
    };
  }
}

const snapshotProvider: Tools = {
  resolveTool(
    name: string,
    config: ToolConfig,
    _agent: Agent,
    capabilities: CapabilitySet | undefined,
  ): Tool | null {
    if (name === "snapshot") return new SnapshotTool(config, capabilities);
    return null;
  },
  close() {
    /* noop */
  },
};

function toolCallUpdates(
  events: SessionUpdate[],
): Array<SessionUpdate & { sessionUpdate: "tool_call_update" }> {
  return events.filter(
    (e): e is SessionUpdate & { sessionUpdate: "tool_call_update" } =>
      e.sessionUpdate === "tool_call_update",
  );
}

describe("emitToolResult with content blocks (test harness end-to-end)", () => {
  it("maps a block array to one content entry per block", async () => {
    const agent = await runAgent(
      {
        name: "img-emit",
        tools: { snapshot: "builtin" },
        capabilities: { snapshot: "*" },
        harness: {
          provider: "test",
          script: [
            [
              { call: { tool: "snapshot", input: {} } },
              { stop: "end_turn" as const },
            ],
          ],
        },
        session: new InMemorySession(),
      },
      { providers: [snapshotProvider] },
    );
    try {
      await agent.prompt("go");
      const events = (await agent.session.pull?.([])) ?? [];
      const update = defined(toolCallUpdates(events)[0]);
      const entries = update.content ?? [];
      expect(entries).toHaveLength(4);
      expect(entries[0]).toEqual({
        type: "content",
        content: { type: "text", text: "before " },
      });
      expect(entries[2]).toEqual({
        type: "content",
        content: { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      });

      // The test harness surfaces the result as text with an image placeholder.
      const surfaced = events.filter(
        (e): e is SessionUpdate & { sessionUpdate: "agent_message_chunk" } =>
          e.sessionUpdate === "agent_message_chunk",
      );
      const texts = surfaced.map((c) =>
        c.content.type === "text" ? c.content.text : "",
      );
      expect(texts).toContain("before and after[image: image/png]");
    } finally {
      await agent.close();
    }
  });

  it("keeps string content as a single text entry", async () => {
    const agent = await runAgent(
      {
        name: "str-emit",
        tools: { snapshot: "builtin" },
        capabilities: { snapshot: "*" },
        harness: {
          provider: "test",
          script: [
            [
              { call: { tool: "snapshot", input: {} } },
              { stop: "end_turn" as const },
            ],
          ],
        },
        session: new InMemorySession(),
      },
      {
        providers: [
          {
            resolveTool(name, config, _agent, capabilities) {
              if (name !== "snapshot") return null;
              const tool = new SnapshotTool(config, capabilities);
              tool.execute = async () => ({ content: "plain result" });
              return tool;
            },
            close() {
              /* noop */
            },
          },
        ],
      },
    );
    try {
      await agent.prompt("go");
      const events = (await agent.session.pull?.([])) ?? [];
      const update = defined(toolCallUpdates(events)[0]);
      expect(update.content).toEqual([
        { type: "content", content: { type: "text", text: "plain result" } },
      ]);
    } finally {
      await agent.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Anthropic harness: the events→messages converter builds tool_result blocks
// for every request (live continuations and history replay share it).
// ---------------------------------------------------------------------------

function anthropicMessageBody(opts: {
  id: string;
  content: unknown[];
  stopReason: string;
}): Record<string, unknown> {
  return {
    id: opts.id,
    type: "message",
    role: "assistant",
    model: "x",
    content: opts.content,
    stop_reason: opts.stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 25,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: "standard",
      cache_creation: null,
      inference_geo: null,
    },
  };
}

function modelInfoResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      type: "model",
      display_name: "x",
      created_at: "2024-01-01T00:00:00Z",
      max_input_tokens: 200000,
      max_tokens: 8192,
      capabilities: null,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const realFetch = global.fetch;

interface ToolResultBlockShape {
  type: string;
  tool_use_id: string;
  content: unknown;
}

/**
 * Stubs fetch for a two-request non-streaming Anthropic exchange (tool_use,
 * then end_turn) and returns the tool_result block from the second request.
 */
function stubAnthropicToolTurn(toolName: string): {
  toolResult: () => ToolResultBlockShape;
} {
  let calls = 0;
  const bodies: Array<Record<string, unknown>> = [];
  global.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/v1/models/")) return modelInfoResponse();
    calls++;
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    const body =
      calls === 1
        ? anthropicMessageBody({
            id: "m1",
            content: [
              { type: "tool_use", id: "toolu_1", name: toolName, input: {} },
            ],
            stopReason: "tool_use",
          })
        : anthropicMessageBody({
            id: "m2",
            content: [{ type: "text", text: "done" }],
            stopReason: "end_turn",
          });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return {
    toolResult: () => {
      const second = defined(bodies[1], "expected a second API request");
      const messages = second.messages as Array<{
        role: string;
        content: unknown;
      }>;
      for (const m of messages) {
        if (m.role !== "user" || !Array.isArray(m.content)) continue;
        for (const block of m.content as ToolResultBlockShape[]) {
          if (block.type === "tool_result") return block;
        }
      }
      throw new Error("no tool_result block found in second request");
    },
  };
}

describe("anthropic converter: tool_result content", () => {
  beforeEach(() => {
    global.fetch = realFetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("emits an array with merged text and base64 image source for image results", async () => {
    const stub = stubAnthropicToolTurn("snapshot");
    const agent = await runAgent(
      {
        name: "img-anthropic",
        tools: { snapshot: "builtin" },
        capabilities: { snapshot: "*" },
        harness: { provider: "anthropic", model: "x", stream: false },
      },
      {
        secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }),
        providers: [snapshotProvider],
      },
    );
    try {
      const result = await agent.prompt("take a screenshot");
      expect(result.stopReason).toBe("end_turn");
      const block = stub.toolResult();
      expect(block.tool_use_id).toBe("toolu_1");
      // Adjacent text merged, empty text dropped, image as base64 source.
      expect(block.content).toEqual([
        { type: "text", text: "before and after" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: PNG_BASE64,
          },
        },
      ]);
    } finally {
      await agent.close();
    }
  });

  it("keeps the plain-string form for text-only results", async () => {
    const stub = stubAnthropicToolTurn("snapshot");
    const agent = await runAgent(
      {
        name: "txt-anthropic",
        tools: { snapshot: "builtin" },
        capabilities: { snapshot: "*" },
        harness: { provider: "anthropic", model: "x", stream: false },
      },
      {
        secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }),
        providers: [
          {
            resolveTool(name, config, _agent, capabilities) {
              if (name !== "snapshot") return null;
              const tool = new SnapshotTool(config, capabilities);
              tool.execute = async () => ({ content: "text only" });
              return tool;
            },
            close() {
              /* noop */
            },
          },
        ],
      },
    );
    try {
      const result = await agent.prompt("go");
      expect(result.stopReason).toBe("end_turn");
      const block = stub.toolResult();
      // Must stay a string (not a one-element array): byte-identical request
      // shapes keep existing conversations' prompt caches valid.
      expect(typeof block.content).toBe("string");
      expect(block.content).toBe("text only");
    } finally {
      await agent.close();
    }
  });
});

// ---------------------------------------------------------------------------
// OpenAI harness: function outputs are strings; image entries flatten to a
// placeholder rather than crashing or leaking base64 into the transcript.
// ---------------------------------------------------------------------------

function openaiResponseEnvelope(opts: {
  output: unknown[];
}): Record<string, unknown> {
  return {
    id: "resp_1",
    object: "response",
    created_at: 0,
    model: "x",
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    output: opts.output,
    usage: {
      input_tokens: 25,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 32,
    },
    metadata: {},
  };
}

function openaiSse(events: Array<Record<string, unknown>>): Response {
  const enc = new TextEncoder();
  let seq = 0;
  const chunks = events.map((e) => {
    const withSeq = { sequence_number: seq++, ...e };
    return enc.encode(
      `event: ${String(e.type)}\ndata: ${JSON.stringify(withSeq)}\n\n`,
    );
  });
  return new Response(
    new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (const c of chunks) ctrl.enqueue(c);
        ctrl.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("openai converter: image entries flatten to a placeholder", () => {
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("sends [image: <mimeType>] in the function_call_output", async () => {
    let calls = 0;
    const bodies: Array<Record<string, unknown>> = [];
    global.fetch = (async (_url: string | URL, init?: RequestInit) => {
      calls++;
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      const output =
        calls === 1
          ? [
              {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "snapshot",
                arguments: "{}",
                status: "completed",
              },
            ]
          : [
              {
                type: "message",
                id: "msg_2",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "done", annotations: [] }],
              },
            ];
      return openaiSse([
        { type: "response.created", response: openaiResponseEnvelope({ output: [] }) },
        {
          type: "response.completed",
          response: openaiResponseEnvelope({ output }),
        },
      ]);
    }) as typeof fetch;

    const agent = await runAgent(
      {
        name: "img-openai",
        tools: { snapshot: "builtin" },
        capabilities: { snapshot: "*" },
        harness: { provider: "openai", model: "gpt-x" },
      },
      {
        secrets: new StaticSecretsStore({ OPENAI_API_KEY: "k" }),
        providers: [snapshotProvider],
      },
    );
    try {
      const result = await agent.prompt("take a screenshot");
      expect(result.stopReason).toBe("end_turn");
      const second = defined(bodies[1], "expected a second API request");
      const input = second.input as Array<Record<string, unknown>>;
      const outputItem = defined(
        input.find((i) => i.type === "function_call_output"),
      );
      expect(outputItem.call_id).toBe("call_1");
      expect(outputItem.output).toBe(
        "before and after[image: image/png]",
      );
    } finally {
      await agent.close();
    }
  });
});
