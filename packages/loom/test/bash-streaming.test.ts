import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

import { BashTool } from "../src/runtime/builtins/bash.js";
import type {
  Agent,
  ToolContext,
  ToolProgress,
} from "../src/types/interfaces.js";

// A wildcard grant runs the real shell unsandboxed, so these tests exercise
// the streaming/output-discipline path on every platform with bash.
function makeProgressCtx(): {
  ctx: ToolContext;
  progressCalls: ToolProgress[];
} {
  const progressCalls: ToolProgress[] = [];
  const stubAgent: Agent = {
    manifest: { name: "test", harness: { provider: "test" } },
    harness: { run: async () => ({ stopReason: "end_turn" }) },
    session: { push: async () => [], pull: async () => [] },
    systemPromptCore: "",
  };
  const ctx: ToolContext = {
    secrets: {},
    abortSignal: new AbortController().signal,
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    agent: stubAgent,
    progress: (u) => progressCalls.push(u),
  };
  return { ctx, progressCalls };
}

function progressText(p: ToolProgress): string {
  return typeof p.content === "string" ? p.content : "";
}

describe("bash streaming via ctx.progress", () => {
  it("streams cumulative output as the process emits it", async () => {
    const tool = new BashTool({}, "*");
    const { ctx, progressCalls } = makeProgressCtx();
    // Three lines spaced past the 100ms throttle so several windows flush.
    const r = await tool.execute(
      { command: "for i in 1 2 3; do echo line$i; sleep 0.15; done" },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("line1\nline2\nline3\n");

    // At least one progress update arrived, and the content grew monotonically
    // toward the final output (cumulative, not delta).
    expect(progressCalls.length).toBeGreaterThan(0);
    const texts = progressCalls.map(progressText);
    for (let i = 1; i < texts.length; i++) {
      expect(texts[i]!.length).toBeGreaterThanOrEqual(texts[i - 1]!.length);
    }
    expect(texts[texts.length - 1]).toContain("line1");
  });

  it("leaves small output untruncated with no footer or spill", async () => {
    const tool = new BashTool({}, "*");
    const { ctx } = makeProgressCtx();
    const r = await tool.execute({ command: "echo hello world" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("hello world\n");
    expect(r.content).not.toContain("[Output truncated");
    const raw = r.display?.rawOutput as { truncated?: boolean; fullOutputPath?: string };
    expect(raw.truncated).toBe(false);
    expect(raw.fullOutputPath).toBeUndefined();
  });

  it("truncates large output and points at the full spill file", async () => {
    const tool = new BashTool({}, "*");
    const { ctx } = makeProgressCtx();
    // 3000 lines exceeds the 2000-line cap.
    const r = await tool.execute({ command: "seq 1 3000" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("[Output truncated");
    // The tail is retained: the last line is present, an early one is not.
    expect(r.content).toContain("3000");
    expect(r.content).not.toContain("\n1\n");

    const raw = r.display?.rawOutput as {
      truncated?: boolean;
      fullOutputPath?: string;
      durationMs?: number;
    };
    expect(raw.truncated).toBe(true);
    expect(typeof raw.durationMs).toBe("number");
    expect(raw.fullOutputPath).toBeDefined();
    // The spill file holds the complete output.
    const full = fs.readFileSync(raw.fullOutputPath!, "utf8");
    expect(full.split("\n")).toContain("1");
    expect(full.split("\n")).toContain("3000");
    fs.rmSync(raw.fullOutputPath!, { force: true });
  });

  it("reports exit code and duration in the display for failures", async () => {
    const tool = new BashTool({}, "*");
    const { ctx } = makeProgressCtx();
    const r = await tool.execute({ command: "echo oops >&2; exit 3" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("exit 3");
    expect(r.content).toContain("oops");
    const raw = r.display?.rawOutput as { exitCode?: number };
    expect(raw.exitCode).toBe(3);
  });
});
