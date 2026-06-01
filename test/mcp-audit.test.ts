import { describe, expect, it } from "vitest";
import * as path from "node:path";

import {
  AuditError,
  auditAgent,
  formatCapabilityTree,
} from "../src/audit/audit.js";
import type { AgentManifest } from "../src/types/manifest.js";

const FIXTURES = path.resolve("test/fixtures");
const ECHO_SERVER = path.join(FIXTURES, "mcp/echo-server.mjs");

function echoMcpProvider(extra: Record<string, unknown> = {}) {
  return {
    provider: "mcp-server",
    command: process.execPath,
    args: [ECHO_SERVER],
    ...extra,
  };
}

describe("audit: MCP-backed providers", () => {
  it("surfaces server info, unexposed tools, and renders them in the text output", async () => {
    const spec: AgentManifest = {
      name: "audit-mcp",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: { echo_mcp: echoMcpProvider() },
      tools: { echo: { provider: "echo_mcp" } },
      capabilities: { echo: "*" },
    };
    const tree = await auditAgent(spec);

    const summary = tree.providers.find((p) => p.handle === "echo_mcp");
    expect(summary).toBeDefined();
    expect(summary!.factoryName).toBe("mcp-server");
    expect(summary!.mcpServer).toBeDefined();
    expect(summary!.mcpServer!.name).toBe("loom-test-mcp-echo");
    expect(summary!.mcpServer!.version).toBe("0.0.1");
    expect(summary!.mcpServer!.protocolVersion).toBe("2024-11-05");
    expect(summary!.mcpServer!.advertisedButUnexposed).toEqual(["add"]);

    const text = formatCapabilityTree(tree, { color: false });
    expect(text).toContain("loom-test-mcp-echo");
    expect(text).toContain("→ factory 'mcp-server'");
    expect(text).toContain("advertised but unexposed (1): add");
  });

  it("surfaces pre-bound args + narrowed schema on the tool entry and text output", async () => {
    const spec: AgentManifest = {
      name: "audit-bound",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: { echo_mcp: echoMcpProvider() },
      tools: { add_to_10: { provider: "echo_mcp", tool: "add" } },
      capabilities: { add_to_10: { a: 10, b: "*" } },
    };
    const tree = await auditAgent(spec);

    const tool = tree.tools.find((t) => t.name === "add_to_10");
    expect(tool).toBeDefined();
    expect(tool!.boundArgs).toEqual(["a"]);
    expect(tool!.inputSchema).toBeDefined();
    const props = (tool!.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(props)).toEqual(["b"]);

    const text = formatCapabilityTree(tree, { color: false });
    expect(text).toContain("pre-bound args: a");
  });

  it("records initError and unresolved tools when the MCP server fails to start", async () => {
    const spec: AgentManifest = {
      name: "audit-bad-mcp",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: {
        bad_mcp: echoMcpProvider({ args: ["/definitely/not/a/real/path.mjs"] }),
      },
      tools: { wat: { provider: "bad_mcp" } },
      capabilities: { wat: "*" },
    };

    let err: AuditError | undefined;
    try {
      await auditAgent(spec);
    } catch (e) {
      err = e as AuditError;
    }
    expect(err).toBeInstanceOf(AuditError);

    const summary = err!.tree.providers.find((p) => p.handle === "bad_mcp");
    expect(summary).toBeDefined();
    expect(summary!.initError).toBeDefined();
    expect(
      err!.tree.unresolvedTools.find((u) => u.name === "wat"),
    ).toBeDefined();
    expect(err!.health.providerInitErrors).toBeGreaterThanOrEqual(1);
    expect(err!.health.unresolvedTools).toBeGreaterThanOrEqual(1);
  });

  it("surfaces per-instance secret needs from the mcp-server config", async () => {
    const prev = process.env.MOCK_API_KEY;
    process.env.MOCK_API_KEY = "test-value";
    let tree: Awaited<ReturnType<typeof auditAgent>>;
    try {
      const spec: AgentManifest = {
        name: "audit-mcp-secrets",
        systemPrompt: "x",
        harness: { provider: "test" },
        providers: {
          echo_mcp: echoMcpProvider({
            secrets: { MOCK_API_KEY: "MOCK_API_KEY" },
          }),
        },
        tools: { echo: { provider: "echo_mcp" } },
        capabilities: { echo: "*" },
      };
      tree = await auditAgent(spec);
    } finally {
      if (prev === undefined) delete process.env.MOCK_API_KEY;
      else process.env.MOCK_API_KEY = prev;
    }

    const entry = tree.secrets.find((s) => s.name === "MOCK_API_KEY");
    expect(entry).toBeDefined();
    expect(entry!.required).toBe(true);
    expect(entry!.requestedBy).toContain("provider:echo_mcp");

    const text = formatCapabilityTree(tree, { color: false });
    expect(text).toContain("MOCK_API_KEY");
    expect(text).toContain("provider:echo_mcp");
  });
});
