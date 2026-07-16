import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";

import {
  runPromptCommand,
  parseContentBlocksJson,
  resolvePromptInput,
  exitCodeForStopReason,
  applyTextModeAugmentation,
  TEXT_MODE_PROMPT_AUGMENTATION,
  TextPromptRenderer,
  TracePromptRenderer,
  JsonlPromptRenderer,
} from "../src/cli/prompt.js";
import type { ContentBlock } from "../src/types/acp.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type { Harness, Runtime } from "../src/types/interfaces.js";
import type { SessionUpdate } from "../src/types/acp.js";

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

function makeRecordingHarness(
  inner: (rt: Runtime) => Promise<SessionUpdate[]>,
): Harness & { systemPromptCore: string | null } {
  return {
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
}

describe("TextPromptRenderer", () => {
  it("renders only the final agent message, coalesced, with a trailing newline", () => {
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
    expect(cap.stderr()).toBe("");
  });

  it("keeps only text after the last tool call", () => {
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

  it("suppresses thoughts, plans, usage, and user echoes", () => {
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

  it("routes non-text content blocks to stderr as placeholders", () => {
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
        data: "x".repeat(16400),
        mimeType: "image/png",
      },
    });
    r.render({ sessionUpdate: "stop", stopReason: "end_turn" });
    r.finish();
    expect(cap.stdout()).toBe("see chart:\n");
    expect(cap.stderr()).toMatch(/^\[image: image\/png, [\d.]+ KB\]\n$/);
  });

  it("emits nothing when the agent produced no text and no stop arrived", () => {
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

  it("emits a stderr usage summary only when usage_update was seen", () => {
    const withUsage = captureStreams();
    const r1 = new TracePromptRenderer(withUsage.streams);
    r1.render({ sessionUpdate: "usage_update", used: 1234, size: 8192 });
    r1.render({ sessionUpdate: "stop", stopReason: "end_turn" });
    r1.finish();
    expect(withUsage.stderr()).toBe("[usage] 1234 / 8192 tokens\n");

    const withoutUsage = captureStreams();
    const r2 = new TracePromptRenderer(withoutUsage.streams);
    r2.render({ sessionUpdate: "stop", stopReason: "end_turn" });
    r2.finish();
    expect(withoutUsage.stderr()).toBe("");
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
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(JSON.parse(lines[0]!)).toEqual(updates[0]);
    expect(JSON.parse(lines[2]!)).toEqual({
      sessionUpdate: "stop",
      stopReason: "end_turn",
    });
  });
});

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

describe("parseContentBlocksJson", () => {
  it("parses a valid non-empty array of typed blocks", () => {
    const blocks = parseContentBlocksJson(
      JSON.stringify([
        { type: "text", text: "look at this" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ]),
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "text", text: "look at this" });
    expect(blocks[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("rejects malformed JSON", () => {
    expect(() => parseContentBlocksJson("{not json")).toThrow(/invalid JSON/);
  });

  it("rejects a non-array top-level value", () => {
    expect(() => parseContentBlocksJson('{"type":"text"}')).toThrow(
      /expected a JSON array/,
    );
  });

  it("rejects an empty array", () => {
    expect(() => parseContentBlocksJson("[]")).toThrow(/empty/);
  });

  it("rejects a block that is not an object", () => {
    expect(() => parseContentBlocksJson('["hi"]')).toThrow(
      /block 0 is not an object/,
    );
  });

  it("rejects a block missing a string type", () => {
    expect(() => parseContentBlocksJson('[{"text":"hi"}]')).toThrow(
      /block 0 is missing a string "type"/,
    );
  });
});

describe("resolvePromptInput", () => {
  const noStdin = () => Promise.resolve("");

  it("uses positional text in text mode", async () => {
    const r = await resolvePromptInput({
      positionalText: "hello there",
      blocksStdin: false,
      readStdin: noStdin,
    });
    expect(r).toEqual({ ok: true, input: "hello there" });
  });

  it("falls back to stdin text when no positional is given", async () => {
    const r = await resolvePromptInput({
      positionalText: "",
      blocksStdin: false,
      readStdin: () => Promise.resolve("from stdin"),
    });
    expect(r).toEqual({ ok: true, input: "from stdin" });
  });

  it("rejects empty text input", async () => {
    const r = await resolvePromptInput({
      positionalText: "",
      blocksStdin: false,
      readStdin: () => Promise.resolve("   \n"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no prompt text supplied/);
  });

  it("parses blocks from stdin under --blocks-stdin", async () => {
    const r = await resolvePromptInput({
      positionalText: "",
      blocksStdin: true,
      readStdin: () =>
        Promise.resolve(
          JSON.stringify([{ type: "image", data: "AAAA", mimeType: "image/png" }]),
        ),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input).toEqual([
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ]);
    }
  });

  it("rejects passing both [text] and --blocks-stdin", async () => {
    const r = await resolvePromptInput({
      positionalText: "some text",
      blocksStdin: true,
      readStdin: () => Promise.reject(new Error("stdin should not be read")),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/do not also pass \[text\]/);
  });

  it("surfaces block validation errors from stdin", async () => {
    const r = await resolvePromptInput({
      positionalText: "",
      blocksStdin: true,
      readStdin: () => Promise.resolve("[]"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty/);
  });
});

describe("runPromptCommand (content-block input)", () => {
  it("passes a ContentBlock[] through to the turn (echoed as user chunks)", async () => {
    const cap = captureStreams();
    const harness = makeRecordingHarness(async () => [
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "got it" },
      },
      { sessionUpdate: "stop", stopReason: "end_turn" },
    ]);
    const manifest: AgentManifest = {
      name: "blocks",
      tools: {},
      harness,
    };
    const input: ContentBlock[] = [
      { type: "text", text: "describe this" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ];
    const code = await runPromptCommand({
      manifest,
      input,
      format: "jsonl",
      streams: cap.streams,
    });
    expect(code).toBe(0);
    const userChunks = cap
      .stdout()
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((u) => u.sessionUpdate === "user_message_chunk")
      .map((u) => u.content);
    expect(userChunks).toContainEqual({ type: "text", text: "describe this" });
    expect(userChunks).toContainEqual({
      type: "image",
      data: "AAAA",
      mimeType: "image/png",
    });
  });
});

describe("runPromptCommand (end-to-end)", () => {
  async function runScenario(opts: {
    updates: SessionUpdate[];
    format: "text" | "trace" | "jsonl";
    text?: string;
    systemPrompt?: string;
    name?: string;
  }): Promise<{
    code: number;
    stdout: string;
    stderr: string;
    systemPromptCore: string | null;
  }> {
    const cap = captureStreams();
    const harness = makeRecordingHarness(async () => opts.updates);
    const manifest: AgentManifest = {
      name: opts.name ?? "scenario",
      ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      tools: {},
      harness,
    };
    const code = await runPromptCommand({
      manifest,
      input: opts.text ?? "hi",
      format: opts.format,
      streams: cap.streams,
    });
    return {
      code,
      stdout: cap.stdout(),
      stderr: cap.stderr(),
      systemPromptCore: harness.systemPromptCore,
    };
  }

  it("text mode: no-tool turn renders the answer, exit 0, and augments the system prompt", async () => {
    const r = await runScenario({
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "4" },
        },
        { sessionUpdate: "stop", stopReason: "end_turn" },
      ],
      format: "text",
      text: "2+2",
      systemPrompt: "You answer math.",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("4\n");
    expect(r.stderr).toBe("");
    expect(r.systemPromptCore).toContain("You answer math.");
    expect(r.systemPromptCore).toContain(TEXT_MODE_PROMPT_AUGMENTATION);
  });

  it("text mode: with a tool dispatch, only the final answer reaches stdout", async () => {
    const r = await runScenario({
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Let me check..." },
        },
        {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "stub",
          status: "in_progress",
          rawInput: {},
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: "tool-output" } },
          ],
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Result: 42." },
        },
        { sessionUpdate: "stop", stopReason: "end_turn" },
      ],
      format: "text",
      text: "go",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Result: 42.\n");
    expect(r.stderr).toBe("");
  });

  it("text mode: a final-message image becomes a stderr placeholder", async () => {
    const r = await runScenario({
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "see:" },
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "image", data: "AAAA", mimeType: "image/png" },
        },
        { sessionUpdate: "stop", stopReason: "end_turn" },
      ],
      format: "text",
      text: "show",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("see:\n");
    expect(r.stderr).toMatch(/\[image: image\/png/);
  });

  it("trace mode: leaves the system prompt unaugmented and traces every event", async () => {
    const r = await runScenario({
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ok" },
        },
        { sessionUpdate: "stop", stopReason: "end_turn" },
      ],
      format: "trace",
      systemPrompt: "You are helpful.",
    });
    expect(r.code).toBe(0);
    expect(r.systemPromptCore).toBe("You are helpful.");
    expect(r.stdout).toContain("[user] hi");
    expect(r.stdout).toContain("[agent] ok");
    expect(r.stdout).toContain("[stop] end_turn");
  });

  it("jsonl mode: leaves the system prompt unaugmented and emits one event per line", async () => {
    const r = await runScenario({
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ok" },
        },
        { sessionUpdate: "stop", stopReason: "end_turn" },
      ],
      format: "jsonl",
      systemPrompt: "You are helpful.",
    });
    expect(r.code).toBe(0);
    expect(r.systemPromptCore).toBe("You are helpful.");
    const lines = r.stdout.trimEnd().split("\n");
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    const kinds = lines.map((l) => JSON.parse(l).sessionUpdate);
    expect(kinds).toContain("user_message_chunk");
    expect(kinds).toContain("agent_message_chunk");
    expect(kinds).toContain("stop");
  });

  it.each<[number, "max_turn_requests" | "cancelled"]>([
    [1, "max_turn_requests"],
    [130, "cancelled"],
  ])("stop reason '%s' → exit %i", async (code, stopReason) => {
    const r = await runScenario({
      updates: [{ sessionUpdate: "stop", stopReason }],
      format: "text",
      text: "go",
    });
    expect(r.code).toBe(code);
  });
});
