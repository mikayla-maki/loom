import { describe, expect, it } from "vitest";
import { runAgent } from "../src/sdk/run-agent.js";
import { CapabilityError } from "../src/errors.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type {
  AuditFinding,
  Tools,
  Tool,
  ToolResult,
} from "../src/types/interfaces.js";

function provider(...tools: Tool[]): Tools {
  return {
    resolveTool(name) {
      return tools.find((t) => t.name === name) ?? null;
    },
    close: () => {},
  };
}

function manifestWith(...tools: Tool[]): AgentManifest {
  return {
    name: "audit-test",
    systemPrompt: "x",
    tools: Object.fromEntries(tools.map((t) => [t.name, "builtin"])),
    capabilities: Object.fromEntries(tools.map((t) => [t.name, "*"])),
    harness: { provider: "test", script: [[{ stop: "end_turn" }]] },
  };
}

/** Runs the agent and returns whatever it threw (or undefined on success). */
async function runAndCatch(
  ...args: Parameters<typeof runAgent>
): Promise<unknown> {
  try {
    await runAgent(...args);
  } catch (e) {
    return e;
  }
  return undefined;
}

function makeTool(opts: {
  name: string;
  audit?: () => AuditFinding[] | Promise<AuditFinding[]>;
}): Tool {
  return {
    name: opts.name,
    description: "x",
    inputSchema: { type: "object" },
    ...(opts.audit ? { audit: opts.audit } : {}),
    async execute(): Promise<ToolResult> {
      return { content: "" };
    },
  };
}

describe("runAgent runtime audit", () => {
  it("throws CapabilityError naming the tool, message, and remediation when audit reports an error", async () => {
    const tool = makeTool({
      name: "broken",
      audit: () => [
        {
          severity: "error",
          message: "missing dep XYZ",
          remediation: "brew install xyz",
        },
      ],
    });
    const caught = await runAndCatch(manifestWith(tool), {
      providers: [provider(tool)],
    });
    expect(caught).toBeInstanceOf(CapabilityError);
    const msg = String(caught);
    expect(msg).toContain("broken");
    expect(msg).toContain("missing dep XYZ");
    expect(msg).toContain("brew install xyz");
  });

  it("aggregates errors across multiple tools", async () => {
    const a = makeTool({
      name: "a",
      audit: () => [{ severity: "error", message: "A is broken" }],
    });
    const b = makeTool({
      name: "b",
      audit: () => [{ severity: "error", message: "B is broken" }],
    });
    const caught = await runAndCatch(manifestWith(a, b), {
      providers: [provider(a, b)],
    });
    expect(String(caught)).toContain("A is broken");
    expect(String(caught)).toContain("B is broken");
  });

  it("forwards non-error findings to onAuditFinding instead of throwing", async () => {
    const tool = makeTool({
      name: "noisy",
      audit: () => [
        { severity: "warning", message: "running degraded" },
        { severity: "ok", message: "all good" },
      ],
    });
    const seen: Array<{ tool: string; severity: string; message: string }> = [];
    const agent = await runAgent(manifestWith(tool), {
      providers: [provider(tool)],
      onAuditFinding: (f) => {
        seen.push({ tool: f.tool, severity: f.severity, message: f.message });
      },
    });
    try {
      expect(seen).toEqual([
        { tool: "noisy", severity: "warning", message: "running degraded" },
        { tool: "noisy", severity: "ok", message: "all good" },
      ]);
    } finally {
      await agent.close();
    }
  });

  it("boots cleanly with no audit() and with non-error findings but no callback", async () => {
    const plain = makeTool({ name: "plain" });
    const a1 = await runAgent(manifestWith(plain), {
      providers: [provider(plain)],
    });
    await a1.close();

    const noisy = makeTool({
      name: "noisy",
      audit: () => [
        { severity: "warning", message: "running degraded" },
        { severity: "ok", message: "all good" },
      ],
    });
    const a2 = await runAgent(manifestWith(noisy), {
      providers: [provider(noisy)],
    });
    await a2.close();
  });

  it("treats an audit() that throws as a single error finding", async () => {
    const tool = makeTool({
      name: "throws",
      audit: () => {
        throw new Error("boom from audit");
      },
    });
    const caught = await runAndCatch(manifestWith(tool), {
      providers: [provider(tool)],
    });
    expect(caught).toBeInstanceOf(CapabilityError);
    expect(String(caught)).toContain("boom from audit");
  });

  it("skipRuntimeAudit bypasses the audit step entirely", async () => {
    let auditCalled = false;
    const tool = makeTool({
      name: "broken",
      audit: () => {
        auditCalled = true;
        return [{ severity: "error", message: "would normally throw" }];
      },
    });
    const agent = await runAgent(manifestWith(tool), {
      providers: [provider(tool)],
      skipRuntimeAudit: true,
    });
    try {
      expect(auditCalled).toBe(false);
    } finally {
      await agent.close();
    }
  });
});
