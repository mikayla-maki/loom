/**
 * Tests for the runtime audit step in runAgent().
 *
 * The static manifest checks (assertRequires, assertKnownKinds, etc.)
 * have their own coverage; this file exercises the per-tool
 * `Tool.audit()` step that runs at boot, throws on `error` findings,
 * and forwards `ok`/`warning` findings to the configured callback.
 */

import { describe, expect, it } from "vitest";
import { runAgent } from "../src/sdk/run-agent.js";
import { CapabilityError } from "../src/errors.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type {
  AuditFinding,
  Provider,
  Tool,
  ToolResult,
} from "../src/types/interfaces.js";

function manifestWith(tool: Tool): AgentManifest {
  return {
    name: "audit-test",
    systemPrompt: "x",
    tools: { [tool.name]: {} },
    capabilities: { [tool.name]: "*" },
    harness: { provider: "test", script: [[{ stop: "end_turn" }]] },
  };
}

function provider(tool: Tool): Provider {
  return {
    resolveTool(name) {
      return name === tool.name ? tool : null;
    },
    close: () => {},
  };
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
  it("throws CapabilityError when a tool's audit reports an error", async () => {
    const tool = makeTool({
      name: "broken",
      audit: () => [
        {
          severity: "error",
          message: "the binary I need isn't installed",
          remediation: "install it",
        },
      ],
    });
    await expect(
      runAgent(manifestWith(tool), { providers: [provider(tool)] }),
    ).rejects.toThrow(CapabilityError);
  });

  it("error message mentions the tool name and the finding", async () => {
    const tool = makeTool({
      name: "broken",
      audit: () => [
        { severity: "error", message: "missing dep XYZ", remediation: "brew install xyz" },
      ],
    });
    let caught: unknown;
    try {
      await runAgent(manifestWith(tool), { providers: [provider(tool)] });
    } catch (e) {
      caught = e;
    }
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
    const manifest: AgentManifest = {
      name: "multi",
      systemPrompt: "x",
      tools: { a: {}, b: {} },
      capabilities: { a: "*", b: "*" },
      harness: { provider: "test", script: [[{ stop: "end_turn" }]] },
    };
    const aggregateProvider: Provider = {
      resolveTool(name) {
        if (name === "a") return a;
        if (name === "b") return b;
        return null;
      },
      close: () => {},
    };
    let caught: unknown;
    try {
      await runAgent(manifest, { providers: [aggregateProvider] });
    } catch (e) {
      caught = e;
    }
    expect(String(caught)).toContain("A is broken");
    expect(String(caught)).toContain("B is broken");
  });

  it("forwards `warning` findings to onAuditFinding instead of throwing", async () => {
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

  it("non-error findings without onAuditFinding are silently dropped", async () => {
    const tool = makeTool({
      name: "noisy",
      audit: () => [
        { severity: "warning", message: "running degraded" },
        { severity: "ok", message: "all good" },
      ],
    });
    // No onAuditFinding option → boot still succeeds, no throw.
    const agent = await runAgent(manifestWith(tool), {
      providers: [provider(tool)],
    });
    await agent.close();
  });

  it("tools without audit() are ignored (no findings)", async () => {
    const tool = makeTool({ name: "plain" });
    const agent = await runAgent(manifestWith(tool), {
      providers: [provider(tool)],
    });
    await agent.close();
  });

  it("an audit() that throws is treated as a single error finding", async () => {
    const tool = makeTool({
      name: "throws",
      audit: () => {
        throw new Error("boom from audit");
      },
    });
    let caught: unknown;
    try {
      await runAgent(manifestWith(tool), { providers: [provider(tool)] });
    } catch (e) {
      caught = e;
    }
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
