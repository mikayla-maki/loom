/**
 * Audit + diagnostics for MCP-backed tools (Chunk 7).
 *
 * Verifies that `auditAgent` surfaces:
 *   - MCP server info (name, version, protocol version)
 *   - Tools the server advertised but the manifest didn't expose
 *   - Pre-bound argument names per tool (without leaking values)
 *   - Init errors when the MCP server fails to start
 *   - Each MCP tool's narrowed inputSchema
 */

import { describe, expect, it } from "vitest";
import * as path from "node:path";

import { AuditError, auditAgent } from "../src/audit/audit.js";
import type { AgentManifest } from "../src/types/manifest.js";

const FIXTURES = path.resolve("test/fixtures");
const ECHO_SERVER = path.join(FIXTURES, "mcp/echo-server.mjs");

describe("audit: MCP-backed providers", () => {
  it("surfaces MCP server info on the provider summary", async () => {
    const spec: AgentManifest = {
      name: "audit-mcp",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: {
        echo_mcp: {
          provider: "mcp-server",
          command: process.execPath,
          args: [ECHO_SERVER],
        },
      },
      tools: {
        echo: { provider: "echo_mcp" },
      },
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
    // The fixture advertises `echo` + `add`; the manifest only
    // exposed `echo`, so `add` should show up as unexposed.
    expect(summary!.mcpServer!.advertisedButUnexposed).toEqual(["add"]);
  });

  it("surfaces pre-bound args + narrowed schema on the tool entry", async () => {
    // `add_to_10` binds `a = 10`. The audited tool entry should
    // report `boundArgs: ["a"]` and a model-visible inputSchema with
    // only `b`.
    const spec: AgentManifest = {
      name: "audit-bound",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: {
        echo_mcp: {
          provider: "mcp-server",
          command: process.execPath,
          args: [ECHO_SERVER],
        },
      },
      tools: {
        add_to_10: { provider: "echo_mcp", mcp_tool: "add" },
      },
      capabilities: {
        add_to_10: { a: 10, b: "*" },
      },
    };
    const tree = await auditAgent(spec);
    const tool = tree.tools.find((t) => t.name === "add_to_10");
    expect(tool).toBeDefined();
    expect(tool!.boundArgs).toEqual(["a"]);
    expect(tool!.inputSchema).toBeDefined();
    const props = (tool!.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(props)).toEqual(["b"]);
  });

  it("records initError when the MCP server fails to start (surfaced via AuditError.tree)", async () => {
    const spec: AgentManifest = {
      name: "audit-bad-mcp",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: {
        bad_mcp: {
          provider: "mcp-server",
          command: process.execPath,
          args: ["/definitely/not/a/real/path.mjs"],
        },
      },
      tools: {
        wat: { provider: "bad_mcp" },
      },
      capabilities: { wat: "*" },
    };
    // Audit throws because the manifest isn't fully resolvable;
    // the partial tree comes back on the error so we can still
    // inspect what went wrong.
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
    // Tools route through this dead provider → unresolved.
    expect(
      err!.tree.unresolvedTools.find((u) => u.name === "wat"),
    ).toBeDefined();
    // Health summary categorises both problems.
    expect(err!.health.providerInitErrors).toBeGreaterThanOrEqual(1);
    expect(err!.health.unresolvedTools).toBeGreaterThanOrEqual(1);
  });

  it("formatCapabilityTree includes MCP server name + pre-bound args in the text output", async () => {
    const spec: AgentManifest = {
      name: "audit-format-mcp",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: {
        echo_mcp: {
          provider: "mcp-server",
          command: process.execPath,
          args: [ECHO_SERVER],
        },
      },
      tools: {
        add_to_10: { provider: "echo_mcp", mcp_tool: "add" },
      },
      capabilities: { add_to_10: { a: 10, b: "*" } },
    };
    const tree = await auditAgent(spec);
    const { formatCapabilityTree } = await import("../src/audit/audit.js");
    const text = formatCapabilityTree(tree, { color: false });
    expect(text).toContain("loom-test-mcp-echo");
    expect(text).toContain("→ factory 'mcp-server'");
    expect(text).toContain("pre-bound args: a");
    expect(text).toContain("advertised but unexposed (1): echo");
  });
});
