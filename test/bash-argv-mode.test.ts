/**
 * Unit coverage for the bash tool's argv mode.
 *
 * Argv mode is engaged when `commands` is a non-empty array on the
 * grant. The grant determines:
 *   - the input schema (enum of allowed command names),
 *   - the tool description (model-facing affordance),
 *   - the dispatch path (direct `spawn`, no `bash -c`).
 *
 * Shell mode is the existing behaviour (`commands = "*"` or the
 * whole-tool `"*"` opt-out). These tests pin the mode-switching
 * logic at the tool level without engaging the OS sandbox — the
 * sandbox is wired into the same execute path and covered by
 * `bash-sandbox-integration` / `bash-bwrap-integration`.
 */

import { describe, expect, it } from "vitest";

import { BashTool } from "../src/runtime/builtins/bash.js";
import type {
  Agent,
  ToolContext,
  ToolResult,
} from "../src/types/interfaces.js";

function makeCtx(): ToolContext {
  const stubAgent: Agent = {
    manifest: { name: "test", harness: { provider: "test" } },
    harness: { run: async () => ({ stopReason: "end_turn" }) },
    session: { push: async () => [], pull: async () => [] },
    systemPromptCore: "",
  };
  return {
    secrets: {},
    abortSignal: new AbortController().signal,
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    agent: stubAgent,
  };
}

describe("bash: shell mode (commands = '*')", () => {
  it("exposes the classic { command: string } schema", () => {
    // Wide-open grant ("*") opts out of the sandbox entirely but
    // stays in shell mode. The schema must still be the free-form
    // command-string shape.
    const tool = new BashTool({}, "*");
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      required: ["command"],
      properties: expect.objectContaining({
        command: expect.objectContaining({ type: "string" }),
      }),
    });
  });

  it("structured grant with commands = '*' is also shell mode", () => {
    const tool = new BashTool({}, { commands: "*", paths: ["./"] });
    expect(tool.inputSchema).toMatchObject({
      required: ["command"],
      properties: expect.objectContaining({
        command: expect.objectContaining({ type: "string" }),
      }),
    });
    // Description varies by mode; shell-mode lede mentions "bash command".
    expect(tool.description).toContain("bash command");
  });
});

describe("bash: argv mode (commands = [...])", () => {
  it("single-command grant collapses the schema to args-only", () => {
    // commands = ["pwd"] means the model never picks `command` — it
    // just supplies args (if any).
    const tool = new BashTool({}, { commands: ["pwd"], paths: ["./"] });
    const schema = tool.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["args", "cwd", "timeout_ms"]),
    );
    // `command` is NOT exposed for a single-command grant.
    expect(props.command).toBeUndefined();
    expect(schema.required).toBeUndefined();
  });

  it("multi-command grant exposes a `command` enum + args", () => {
    const tool = new BashTool({}, { commands: ["pwd", "cat"], paths: ["./"] });
    const schema = tool.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    const cmdProp = props.command as Record<string, unknown>;
    expect(cmdProp.type).toBe("string");
    expect(cmdProp.enum).toEqual(["pwd", "cat"]);
    expect(schema.required).toEqual(["command"]);
    expect(props.args).toBeDefined();
  });

  it("description names the allowed commands directly", () => {
    const single = new BashTool({}, { commands: ["pwd"] });
    expect(single.description).toContain("`pwd`");
    expect(single.description).toContain("no shell");

    const multi = new BashTool({}, { commands: ["pwd", "cat"] });
    expect(multi.description).toContain("pwd");
    expect(multi.description).toContain("cat");
    expect(multi.description).toContain("no shell");
  });

  it("rejects empty commands list at construction", () => {
    // An empty list means the model has nothing to pick from — useless
    // tool, almost certainly a manifest mistake. Boot here so the
    // user fixes it.
    expect(() => new BashTool({}, { commands: [] })).toThrow(/non-empty array/);
  });

  it("executes the single allowed command via direct spawn (no shell)", async () => {
    // `pwd` is universally available and exits 0 with a deterministic
    // line of output. We don't need the sandbox engaged to validate
    // the dispatch path — we DO want to validate the actual exec.
    // Wide-open paths/env so the sandbox layer is a no-op when
    // present.
    const tool = new BashTool(
      {},
      { commands: ["pwd"], paths: "*", network: "*", env: "*" },
    );
    const r: ToolResult = await tool.execute({ args: [] }, makeCtx());
    expect(r.isError).toBeFalsy();
    expect(typeof r.content).toBe("string");
    // /bin/pwd prints the cwd; we don't assert the exact value because
    // the sandbox may canonicalise it differently from process.cwd().
    expect((r.content as string).trim().length).toBeGreaterThan(0);
  });

  it("multi-command grant: the model picks from the allowlist", async () => {
    const tool = new BashTool(
      {},
      { commands: ["pwd", "echo"], paths: "*", network: "*", env: "*" },
    );
    const r = await tool.execute(
      { command: "echo", args: ["hello", "world"] },
      makeCtx(),
    );
    expect(r.isError).toBeFalsy();
    expect((r.content as string).trim()).toBe("hello world");
  });

  it("rejects a multi-mode command not in the allowlist at dispatch time", async () => {
    // Defensive belt-and-suspenders: the schema enum would normally
    // catch this upstream, but the bash tool ALSO validates so a
    // direct caller (no ajv) can't sneak through. Single-command
    // mode doesn't surface `command` to the model (the choice is
    // implicit), so the rejection only fires in multi-command mode.
    const tool = new BashTool(
      {},
      { commands: ["pwd", "echo"], paths: "*", env: "*" },
    );
    await expect(
      tool.execute({ command: "rm", args: ["-rf", "/"] }, makeCtx()),
    ).rejects.toThrow(/not in the allowlist/);
  });

  it("single-command mode ignores any `command` the caller supplies", async () => {
    // Single-mode schema doesn't expose `command`; if a direct
    // caller passes one anyway, we don't honour it — the one allowed
    // command always runs. Pin this behaviour so it doesn't drift.
    const tool = new BashTool({}, { commands: ["echo"], paths: "*", env: "*" });
    const r = await tool.execute(
      // `command: "rm"` is ignored; argv becomes ["echo", "safe"].
      { command: "rm", args: ["safe"] } as unknown as { args: string[] },
      makeCtx(),
    );
    expect(r.isError).toBeFalsy();
    expect((r.content as string).trim()).toBe("safe");
  });
});
