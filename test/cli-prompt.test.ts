/**
 * `loom prompt` CLI surface — renderer behaviour, exit-code mapping,
 * and the text-mode system-prompt augmentation. Drives the same
 * entry point the CLI uses (`runPromptCommand`) with in-memory
 * manifests and captured streams; no subprocess.
 */

import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";

import {
  runPromptCommand,
  exitCodeForStopReason,
  applyTextModeAugmentation,
  TEXT_MODE_PROMPT_AUGMENTATION,
  TextPromptRenderer,
  TracePromptRenderer,
  JsonlPromptRenderer,
} from "../src/cli/prompt.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type { Harness, Runtime } from "../src/types/interfaces.js";
import type { SessionUpdate } from "../src/types/acp.js";

// ──────────────────────────────────────────────────────────────────
// Stream capture helpers
// ──────────────────────────────────────────────────────────────────

interface Capture {
  stdout: () => string;
  stderr: () => string;
  streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
}

function captureStreams(): Capture {
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      outChunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      errChunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return {
    stdout: () => Buffer.concat(outChunks).toString("utf8"),
    stderr: () => Buffer.concat(errChunks).toString("utf8"),
    streams: { stdout, stderr },
  };
}

// ──────────────────────────────────────────────────────────────────
// Inline harness helpers
// ──────────────────────────────────────────────────────────────────

/** A Harness that records the systemPromptCore it sees and runs a callback. */
function makeRecordingHarness(
  inner: (rt: Runtime) => Promise<SessionUpdate[]>,
): Harness & { systemPromptCore: string | null } {
  const h = {
    systemPromptCore: null as string | null,
    async run(rt: Runtime) {
      this.systemPromptCore = rt.systemPromptCore();
      const updates = await inner(rt);
      for (const u of updates) await rt.update(u);
      const last = updates[updates.length - 1];
      if (last && last.sessionUpdate === "stop") {
        return { stopReason: last.stopReason };
      }
      await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
      return { stopReason: "end_turn" as const };
    },
  };
  return h;
}

// ──────────────────────────────────────────────────────────────────
// Renderer unit tests — synthetic update streams
// ──────────────────────────────────────────────────────────────────

describe("TextPromptRenderer", () => {
  it("emits the final agent message on stop, with a trailing newline", () => {
    const cap = captureStreams();
    const r = new TextPromptRenderer(cap.streams);
    r.render({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "4" },
    });
    r.render({ sessionUpdate: "stop", stopReason: "end_turn" });
    r.finish();
    expect(cap.stdout()).toBe("4\n");
    expect(cap.stderr()).toBe("");
  });

  it("coalesces multiple agent chunks into one stdout write", () => {
    const cap = captureStreams();
    const r = new TextPromptRenderer(cap.streams);
    r.render({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello" },
    });
    r.render({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " " },
    });
    r.render({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "world." },
    });
    r.render({ sessionUpdate: "stop", stopReason: "end_turn" });
    r.finish();
    expect(cap.stdout()).toBe("Hello world.\n");
  });

  it("drops text that comes before a tool call (only post-last-tool text is final)", () => {
    const cap = captureStreams();
    const r = new TextPromptRenderer(cap.streams);
    r.render({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Let me check..." },
    });
    r.render({
      sessionUpdate: "tool_call",
      toolCallId: "1",
      title: "bash",
      status: "in_progress",
      rawInput: { command: "ls" },
    });
    r.render({
      sessionUpdate: "tool_call_update",
      toolCallId: "1",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "file.txt" } },
      ],
    });
    r.render({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Result: 42." },
    });
    r.render({ sessionUpdate: "stop", stopReason: "end_turn" });
    r.finish();
    expect(cap.stdout()).toBe("Result: 42.\n");
  });

  it("suppresses thoughts, plans, usage, user echoes", () => {
    const cap = captureStreams();
    const r = new TextPromptRenderer(cap.streams);
    r.render({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "hi" },
    });
    r.render({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "secret reasoning" },
    });
    r.render({ sessionUpdate: "usage_update", used: 10, size: 100 });
    r.render({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "answer" },
    });
    r.render({ sessionUpdate: "stop", stopReason: "end_turn" });
    r.finish();
    expect(cap.stdout()).toBe("answer\n");
    expect(cap.stderr()).toBe("");
  });

  it("routes non-text content blocks in the final message to stderr as placeholders", () => {
    const cap = captureStreams();
    const r = new TextPromptRenderer(cap.streams);
    r.render({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "see chart:" },
    });
    r.render({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "image",
        // ~12.3 KB of base64 (16400 chars → 12.3 KB).
        data: "x".repeat(16400),
        mimeType: "image/png",
      },
    });
    r.render({ sessionUpdate: "stop", stopReason: "end_turn" });
    r.finish();
    expect(cap.stdout()).toBe("see chart:\n");
    expect(cap.stderr()).toMatch(/^\[image: image\/png, [\d.]+ KB\]\n$/);
  });

  it("emits nothing if the agent produced no text and no stop arrived", () => {
    const cap = captureStreams();
    const r = new TextPromptRenderer(cap.streams);
    r.finish();
    expect(cap.stdout()).toBe("");
    expect(cap.stderr()).toBe("");
  });
});

describe("TracePromptRenderer", () => {
  it("coalesces consecutive agent chunks into one [agent] line", () => {
    const cap = captureStreams();
    const r = new TracePromptRenderer(cap.streams);
    r.render({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "check disk" },
    });
    r.render({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "You have " },
    });
    r.render({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "32GB free." },
    });
    r.render({ sessionUpdate: "stop", stopReason: "end_turn" });
    r.finish();
    const out = cap.stdout();
    expect(out).toContain("[user] check disk\n");
    expect(out).toContain("[agent] You have 32GB free.\n");
    expect(out).toContain("[stop] end_turn\n");
    // exactly one [agent] line, not three:
    expect(out.match(/\[agent\]/g)?.length).toBe(1);
  });

  it("renders tool calls with status glyphs and brief input", () => {
    const cap = captureStreams();
    const r = new TracePromptRenderer(cap.streams);
    r.render({
      sessionUpdate: "tool_call",
      toolCallId: "1",
      title: "bash",
      status: "in_progress",
      rawInput: { command: "df -h" },
    });
    r.render({
      sessionUpdate: "tool_call_update",
      toolCallId: "1",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "Filesystem ..." } },
      ],
    });
    r.render({ sessionUpdate: "stop", stopReason: "end_turn" });
    r.finish();
    const out = cap.stdout();
    expect(out).toContain('[tool] bash {"command":"df -h"}');
    expect(out).toContain("[tool ✓] Filesystem ...");
    expect(out).toContain("[stop] end_turn");
  });

  it("emits a stderr usage summary if usage_update was seen", () => {
    const cap = captureStreams();
    const r = new TracePromptRenderer(cap.streams);
    r.render({ sessionUpdate: "usage_update", used: 1234, size: 8192 });
    r.render({ sessionUpdate: "stop", stopReason: "end_turn" });
    r.finish();
    expect(cap.stderr()).toBe("[usage] 1234 / 8192 tokens\n");
  });

  it("omits the usage line when no usage_update arrived", () => {
    const cap = captureStreams();
    const r = new TracePromptRenderer(cap.streams);
    r.render({ sessionUpdate: "stop", stopReason: "end_turn" });
    r.finish();
    expect(cap.stderr()).toBe("");
  });
});

describe("JsonlPromptRenderer", () => {
  it("emits one valid JSON object per line, verbatim", () => {
    const cap = captureStreams();
    const r = new JsonlPromptRenderer(cap.streams);
    const updates: SessionUpdate[] = [
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "hi" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
      { sessionUpdate: "stop", stopReason: "end_turn" },
    ];
    for (const u of updates) r.render(u);
    r.finish();
    const lines = cap.stdout().trimEnd().split("\n");
    expect(lines.length).toBe(3);
    for (const l of lines) {
      // Each line is valid JSON (jq-compatible shape).
      expect(() => JSON.parse(l)).not.toThrow();
    }
    expect(JSON.parse(lines[0]!)).toEqual(updates[0]);
    expect(JSON.parse(lines[2]!)).toEqual({
      sessionUpdate: "stop",
      stopReason: "end_turn",
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// Exit-code mapping
// ──────────────────────────────────────────────────────────────────

describe("exitCodeForStopReason", () => {
  it("maps known stop reasons to Unix conventions", () => {
    expect(exitCodeForStopReason("end_turn")).toBe(0);
    expect(exitCodeForStopReason("cancelled")).toBe(130);
    expect(exitCodeForStopReason("max_tokens")).toBe(1);
    expect(exitCodeForStopReason("max_turn_requests")).toBe(1);
    expect(exitCodeForStopReason("refusal")).toBe(1);
    expect(exitCodeForStopReason("error")).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// System-prompt augmentation
// ──────────────────────────────────────────────────────────────────

describe("applyTextModeAugmentation", () => {
  it("appends the augmentation to an existing literal system prompt", () => {
    const out = applyTextModeAugmentation({
      name: "x",
      systemPrompt: "Be helpful.",
      harness: { provider: "test" },
    });
    expect(typeof out.systemPrompt).toBe("string");
    expect(out.systemPrompt as string).toContain("Be helpful.");
    expect(out.systemPrompt as string).toContain(TEXT_MODE_PROMPT_AUGMENTATION);
  });

  it("uses the augmentation as the prompt when none was set", () => {
    const out = applyTextModeAugmentation({
      name: "x",
      harness: { provider: "test" },
    });
    expect(out.systemPrompt).toBe(TEXT_MODE_PROMPT_AUGMENTATION);
  });
});

// ──────────────────────────────────────────────────────────────────
// End-to-end: runPromptCommand with an inline harness
// ──────────────────────────────────────────────────────────────────

describe("runPromptCommand (end-to-end)", () => {
  it("text mode: no-tool turn → stdout = answer + \\n, exit 0", async () => {
    const cap = captureStreams();
    const harness = makeRecordingHarness(async () => [
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "4" },
      },
      { sessionUpdate: "stop", stopReason: "end_turn" },
    ]);
    const manifest: AgentManifest = {
      name: "txt-no-tool",
      systemPrompt: "You answer math.",
      tools: {},
      harness,
    };
    const code = await runPromptCommand({
      manifest,
      text: "2+2",
      format: "text",
      streams: cap.streams,
    });
    expect(code).toBe(0);
    expect(cap.stdout()).toBe("4\n");
    expect(cap.stderr()).toBe("");
  });

  it("text mode: multi-segment turn with a tool → only the final answer reaches stdout", async () => {
    const cap = captureStreams();
    // Emit the same SessionUpdate sequence a real tool dispatch
    // produces, without actually wiring a tool registration —
    // we're testing the renderer's coalescing behaviour, not the
    // tool table.
    const harness: Harness = {
      async run(rt: Runtime) {
        await rt.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Let me check..." },
        });
        await rt.update({
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "stub",
          status: "in_progress",
          rawInput: {},
        });
        await rt.update({
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "tool-output" },
            },
          ],
        });
        await rt.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Result: 42." },
        });
        await rt.update({
          sessionUpdate: "stop",
          stopReason: "end_turn",
        });
        return { stopReason: "end_turn" as const };
      },
    };
    const manifest: AgentManifest = {
      name: "txt-tools",
      tools: {},
      harness,
    };
    const code = await runPromptCommand({
      manifest,
      text: "go",
      format: "text",
      streams: cap.streams,
    });
    expect(code).toBe(0);
    expect(cap.stdout()).toBe("Result: 42.\n");
    expect(cap.stderr()).toBe("");
  });

  it("text mode: final message with image → stderr placeholder", async () => {
    const cap = captureStreams();
    const harness = makeRecordingHarness(async () => [
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "see:" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "image",
          data: "AAAA",
          mimeType: "image/png",
        },
      },
      { sessionUpdate: "stop", stopReason: "end_turn" },
    ]);
    const manifest: AgentManifest = {
      name: "txt-image",
      tools: {},
      harness,
    };
    const code = await runPromptCommand({
      manifest,
      text: "show",
      format: "text",
      streams: cap.streams,
    });
    expect(code).toBe(0);
    expect(cap.stdout()).toBe("see:\n");
    expect(cap.stderr()).toMatch(/\[image: image\/png/);
  });

  it("text mode: system prompt augmentation reaches the harness", async () => {
    const cap = captureStreams();
    const harness = makeRecordingHarness(async () => [
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "ok" },
      },
      { sessionUpdate: "stop", stopReason: "end_turn" },
    ]);
    const manifest: AgentManifest = {
      name: "txt-augment",
      systemPrompt: "You are helpful.",
      tools: {},
      harness,
    };
    const code = await runPromptCommand({
      manifest,
      text: "hi",
      format: "text",
      streams: cap.streams,
    });
    expect(code).toBe(0);
    expect(harness.systemPromptCore).not.toBeNull();
    expect(harness.systemPromptCore).toContain("You are helpful.");
    expect(harness.systemPromptCore).toContain(TEXT_MODE_PROMPT_AUGMENTATION);
  });

  it("trace mode: does NOT augment the system prompt", async () => {
    const cap = captureStreams();
    const harness = makeRecordingHarness(async () => [
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "ok" },
      },
      { sessionUpdate: "stop", stopReason: "end_turn" },
    ]);
    const manifest: AgentManifest = {
      name: "trace-noaug",
      systemPrompt: "You are helpful.",
      tools: {},
      harness,
    };
    const code = await runPromptCommand({
      manifest,
      text: "hi",
      format: "trace",
      streams: cap.streams,
    });
    expect(code).toBe(0);
    expect(harness.systemPromptCore).toBe("You are helpful.");
    // The user echo and agent message both appear, plus stop:
    const out = cap.stdout();
    expect(out).toContain("[user] hi");
    expect(out).toContain("[agent] ok");
    expect(out).toContain("[stop] end_turn");
  });

  it("jsonl mode: each event on its own line; no augmentation", async () => {
    const cap = captureStreams();
    const harness = makeRecordingHarness(async () => [
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "ok" },
      },
      { sessionUpdate: "stop", stopReason: "end_turn" },
    ]);
    const manifest: AgentManifest = {
      name: "jsonl",
      systemPrompt: "You are helpful.",
      tools: {},
      harness,
    };
    const code = await runPromptCommand({
      manifest,
      text: "hi",
      format: "jsonl",
      streams: cap.streams,
    });
    expect(code).toBe(0);
    expect(harness.systemPromptCore).toBe("You are helpful.");
    const lines = cap.stdout().trimEnd().split("\n");
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    // sanity: includes user, agent, stop
    const kinds = lines.map((l) => JSON.parse(l).sessionUpdate);
    expect(kinds).toContain("user_message_chunk");
    expect(kinds).toContain("agent_message_chunk");
    expect(kinds).toContain("stop");
  });

  it("max_turn_requests stop → exit 1", async () => {
    const cap = captureStreams();
    const harness = makeRecordingHarness(async () => [
      { sessionUpdate: "stop", stopReason: "max_turn_requests" },
    ]);
    const manifest: AgentManifest = {
      name: "maxturns",
      tools: {},
      harness,
    };
    const code = await runPromptCommand({
      manifest,
      text: "go",
      format: "text",
      streams: cap.streams,
    });
    expect(code).toBe(1);
  });

  it("cancelled stop → exit 130", async () => {
    const cap = captureStreams();
    const harness = makeRecordingHarness(async () => [
      { sessionUpdate: "stop", stopReason: "cancelled" },
    ]);
    const manifest: AgentManifest = {
      name: "cancelled",
      tools: {},
      harness,
    };
    const code = await runPromptCommand({
      manifest,
      text: "go",
      format: "text",
      streams: cap.streams,
    });
    expect(code).toBe(130);
  });
});
