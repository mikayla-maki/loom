import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import {
  resolveManifest,
  resolveSystemPrompt,
} from "../src/manifest/resolver.js";
import { runAgent } from "../src/sdk/run-agent.js";
import { CapabilityError, ResolutionError } from "../src/errors.js";
import { InMemorySession } from "../src/builtins/session/memory.js";
import type { AgentManifest } from "../src/types/manifest.js";

const FIXTURES = path.resolve("test/fixtures");

describe("manifest walk via runAgent", () => {
  it("resolves the sample agent end-to-end", async () => {
    // The fixture stays file-based on purpose: exercises on-disk
    // system_prompt resolution and v2 [capabilities] grants.
    const agent = await runAgent(
      path.join(FIXTURES, "sample-agent/agent.toml"),
      {},
    );
    try {
      const tools = agent.agentState.toolTable.list().map((t) => t.name);
      expect(tools.sort()).toEqual(["find", "read_file", "write_file"]);
      // The agent surfaces the granted caps from [capabilities].
      expect(agent.capabilities.read_file).toEqual({ paths: ["./"] });
    } finally {
      await agent.close();
    }
  });

  it("empty [tools] table opts out of the default builtin set", async () => {
    const spec: AgentManifest = {
      name: "no-defaults",
      systemPrompt: "be brief",
      tools: {},
      harness: { provider: "test" },
    };
    const agent = await runAgent(spec, {});
    try {
      expect(agent.agentState.toolTable.list()).toHaveLength(0);
    } finally {
      await agent.close();
    }
  });

  it("rejects when a tool's `requires` aren't granted", async () => {
    const spec: AgentManifest = {
      name: "snoopy",
      systemPrompt: "x",
      // bash requires `subprocess`; the grant is empty → boot fails.
      tools: { bash: "builtin" },
      harness: { provider: "test" },
      capabilities: { bash: {} },
    };
    await expect(runAgent(spec, {})).rejects.toThrow(CapabilityError);
  });

  it("fails when no provider claims a referenced tool name", async () => {
    const spec: AgentManifest = {
      name: "unknown-tool",
      systemPrompt: "x",
      tools: { not_a_real_tool: "builtin" },
      harness: { provider: "test" },
    };
    await expect(runAgent(spec, {})).rejects.toThrow(ResolutionError);
  });

  it("produces ordered chain bindings from a SessionSpec[] manifest", () => {
    const spec: AgentManifest = {
      name: "chain-resolver",
      systemPrompt: "x",
      harness: { provider: "test" },
      session: [
        { provider: "compacting", threshold: 60 },
        { provider: "in-memory" },
      ],
    };
    const r = resolveManifest(spec);
    expect(Array.isArray(r.session)).toBe(true);
    expect(r.session).toHaveLength(2);
    expect(r.session![0]!.factoryName).toBe("compacting");
    expect(r.session![0]!.config).toEqual({ threshold: 60 });
    expect(r.session![1]!.factoryName).toBe("in-memory");
  });

  it("wraps singleton SessionSpec into a length-1 binding array", () => {
    const spec: AgentManifest = {
      name: "singleton-resolver",
      systemPrompt: "x",
      harness: { provider: "test" },
      session: { provider: "in-memory" },
    };
    const r = resolveManifest(spec);
    expect(r.session).toHaveLength(1);
    expect(r.session![0]!.factoryName).toBe("in-memory");
  });

  it("pre-built Session instance leaves resolved.session undefined", () => {
    const spec: AgentManifest = {
      name: "prebuilt-resolver",
      systemPrompt: "x",
      harness: { provider: "test" },
      session: new InMemorySession(),
    };
    const r = resolveManifest(spec);
    expect(r.session).toBeUndefined();
  });

  it("resolves [agent].system_prompt as inline string when not path-like", async () => {
    const spec: AgentManifest = {
      name: "inline-sp",
      systemPrompt: "Be concise. Use only tools provided.",
      tools: {},
      harness: { provider: "test" },
    };
    const sp = await resolveSystemPrompt(spec, process.cwd());
    expect(sp).toBe("Be concise. Use only tools provided.");
  });

  // ─── [providers] configured-factory form plumbing (MCP, Chunk 1) ───
  //
  // These tests exercise the resolver IR for the new configured-
  // factory shape. The factory itself doesn't exist yet (Chunk 2
  // wires up `mcp-server`); a fake `test-meta` name is enough to
  // prove the resolver carries everything through correctly.

  it("resolves a [tools.X] entry through a configured-factory [providers] handle", () => {
    const spec: AgentManifest = {
      name: "cf-tool",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: {
        fs_mcp: { provider: "test-meta", npm: "@example/mcp-fs" },
      },
      tools: {
        read_text_file: { provider: "fs_mcp" },
        list_directory: { provider: "fs_mcp" },
      },
    };
    const r = resolveManifest(spec);

    // Two tool bindings, both pointing at the same provider instance
    // (the configured-factory entry is shared by dedup on
    // (factoryName, mergedConfig)).
    expect(r.tools).toHaveLength(2);
    expect(r.tools[0]!.toolName).toBe("read_text_file");
    expect(r.tools[1]!.toolName).toBe("list_directory");
    expect(r.tools[0]!.providerInstanceId).toBe(r.tools[1]!.providerInstanceId);

    // The instance is factory-backed with no source.
    const instance = r.providers.find(
      (p) => p.id === r.tools[0]!.providerInstanceId,
    );
    expect(instance).toBeDefined();
    expect(instance!.kind).toBe("provider");
    expect(instance!.source).toBeUndefined();
    expect(instance!.factoryName).toBe("test-meta");
    expect(instance!.providerHandle).toBe("fs_mcp");
    // Per-handle config carried through verbatim (no tool config to
    // merge in this case).
    expect(instance!.config).toEqual({ npm: "@example/mcp-fs" });
    // Origin reflects the configured-factory shape.
    expect(instance!.origin).toEqual({
      kind: "handle-factory",
      providerHandle: "fs_mcp",
      factoryName: "test-meta",
    });
  });

  it("provider-level and per-tool config are kept SEPARATE (no merge)", () => {
    // Per-tool config (`[tools.X]` minus `provider`) flows to
    // `resolveTool(name, config, ...)`. Provider-level config (the
    // `[providers]` table) flows to `Tools.create()` and is the
    // sole dedup key. Multiple tools through one handle therefore
    // share ONE instance regardless of their per-tool shapes.
    const spec: AgentManifest = {
      name: "cf-split",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: {
        fs_mcp: {
          provider: "test-meta",
          npm: "@example/mcp-fs",
          shared: "from-provider",
        },
      },
      tools: {
        plain: { provider: "fs_mcp", flavour: "vanilla" },
        override: { provider: "fs_mcp", shared: "from-tool" },
      },
    };
    const r = resolveManifest(spec);

    // Both tools share ONE provider instance (one MCP connection).
    expect(r.tools[0]!.providerInstanceId).toBe(r.tools[1]!.providerInstanceId);
    const instance = r.providers.find(
      (p) => p.id === r.tools[0]!.providerInstanceId,
    )!;
    // Instance config = [providers] config only. No per-tool keys.
    expect(instance.config).toEqual({
      npm: "@example/mcp-fs",
      shared: "from-provider",
    });

    // ToolBinding.toolConfig keeps the tool's own config, which is
    // what the factory's `resolveTool(name, config, ...)` receives.
    expect(r.tools[0]!.toolConfig).toEqual({ flavour: "vanilla" });
    expect(r.tools[1]!.toolConfig).toEqual({ shared: "from-tool" });
  });

  it("dedupes tools pointing at the same configured-factory handle, even with different per-tool config", () => {
    // Three different per-tool shapes; one instance.
    const spec: AgentManifest = {
      name: "cf-dedup",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: {
        fs_mcp: { provider: "test-meta", npm: "@example/mcp-fs" },
      },
      tools: {
        a: { provider: "fs_mcp" },
        b: { provider: "fs_mcp", mcp_tool: "something_else" },
        c: { provider: "fs_mcp", note: "per-tool-only" },
      },
    };
    const r = resolveManifest(spec);
    const ids = new Set(r.tools.map((t) => t.providerInstanceId));
    expect(ids.size).toBe(1);
  });

  it("resolves [harness] through a configured-factory [providers] handle", () => {
    // A configured-factory entry can be used to alias a built-in
    // harness factory with pre-bound config. The resolver flattens
    // that into the HarnessBinding.
    const spec: AgentManifest = {
      name: "cf-harness",
      systemPrompt: "x",
      providers: {
        configured: {
          provider: "test",
          locked_config_key: "locked_value",
        },
      },
      harness: { provider: "configured", call_site_key: "call_site_value" },
    };
    const r = resolveManifest(spec);
    expect(r.harness?.factoryName).toBe("test");
    expect(r.harness?.providerHandle).toBe("configured");
    // No source: factory-backed.
    expect(r.harness?.source).toBeUndefined();
    // Merged config: provider-level + call-site (call-site wins).
    expect(r.harness?.config).toEqual({
      locked_config_key: "locked_value",
      call_site_key: "call_site_value",
    });
  });

  it("keeps source-form [providers] entries working in parallel with configured-factory entries", () => {
    const spec: AgentManifest = {
      name: "mixed-providers",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: {
        loaded: { path: "./loaded-provider" },
        configured: { provider: "test-meta", flavour: "a" },
      },
      tools: {
        from_loaded: { provider: "loaded" },
        from_configured: { provider: "configured" },
      },
    };
    const r = resolveManifest(spec);
    const loaded = r.providers.find(
      (p) => p.id === r.tools[0]!.providerInstanceId,
    )!;
    const configured = r.providers.find(
      (p) => p.id === r.tools[1]!.providerInstanceId,
    )!;

    // Source-form binding: `source` set, `factoryName` undefined.
    expect(loaded.source).toEqual({ path: "./loaded-provider" });
    expect(loaded.factoryName).toBeUndefined();

    // Configured-factory binding: `factoryName` set, `source` undefined.
    expect(configured.factoryName).toBe("test-meta");
    expect(configured.source).toBeUndefined();
  });

  it("resolves [agent].system_prompt as a file when path-like", async () => {
    // Path-like system_prompt is a file-on-disk feature; the inline
    // path stays a literal string. This test must remain file-based.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-sp-path-"));
    try {
      const agentDir = path.join(dir, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "core.md"),
        "# Core\n\nbe brief\n",
      );
      await fs.writeFile(
        path.join(agentDir, "agent.toml"),
        `[agent]
name = "path-sp"
system_prompt = "./core.md"
[tools]

[harness]
provider = "test"
[session]
provider = "in-memory"
`,
      );
      const { parseAgentManifest } = await import("../src/manifest/parser.js");
      const manifest = await parseAgentManifest(
        path.join(agentDir, "agent.toml"),
      );
      const sp = await resolveSystemPrompt(manifest, agentDir);
      expect(sp).toMatch(/be brief/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
