import { describe, expect, it } from "vitest";

import { BashTool } from "../src/runtime/builtins/bash.js";
import type { ToolResult } from "../src/types/interfaces.js";
import type { CapabilitySet } from "../src/types/manifest.js";
import { makeCtx } from "./helpers/bash-integration.js";

describe("bash: shell mode (commands = '*')", () => {
  it("exposes the free-form { command: string } schema", () => {
    const grants: CapabilitySet[] = ["*", { commands: "*", paths: ["./"] }];
    for (const grant of grants) {
      const tool = new BashTool({}, grant);
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        required: ["command"],
        properties: expect.objectContaining({
          command: expect.objectContaining({ type: "string" }),
        }),
      });
      expect(tool.description).toContain("bash command");
    }
  });
});

describe("bash: argv mode (commands = [...])", () => {
  it("single-command grant collapses the schema to args-only", () => {
    const tool = new BashTool({}, { commands: ["pwd"], paths: ["./"] });
    const schema = tool.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["args", "cwd", "timeout_ms"]),
    );
    expect(props.command).toBeUndefined();
    expect(schema.required).toBeUndefined();

    expect(tool.description).toContain("`pwd`");
    expect(tool.description).toContain("no shell");
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

    expect(tool.description).toContain("pwd");
    expect(tool.description).toContain("cat");
    expect(tool.description).toContain("no shell");
  });

  it("rejects empty commands list at construction", () => {
    expect(() => new BashTool({}, { commands: [] })).toThrow(/non-empty array/);
  });

  it("executes the single allowed command via direct spawn (no shell)", async () => {
    const tool = new BashTool(
      {},
      { commands: ["pwd"], paths: "*", network: "*", env: "*" },
    );
    const r: ToolResult = await tool.execute({ args: [] }, makeCtx());
    expect(r.isError).toBeFalsy();
    expect(typeof r.content).toBe("string");
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
    const tool = new BashTool(
      {},
      { commands: ["pwd", "echo"], paths: "*", env: "*" },
    );
    await expect(
      tool.execute({ command: "rm", args: ["-rf", "/"] }, makeCtx()),
    ).rejects.toThrow(/not in the allowlist/);
  });

  it("single-command mode ignores any `command` the caller supplies", async () => {
    const tool = new BashTool({}, { commands: ["echo"], paths: "*", env: "*" });
    const r = await tool.execute(
      { command: "rm", args: ["safe"] } as unknown as { args: string[] },
      makeCtx(),
    );
    expect(r.isError).toBeFalsy();
    expect((r.content as string).trim()).toBe("safe");
  });
});
