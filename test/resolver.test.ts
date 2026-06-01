import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import {
  isPreBuiltSessionLayer,
  resolveManifest,
  resolveSystemPrompt,
  type ResolvedSessionLayer,
  type SessionBinding,
} from "../src/manifest/resolver.js";
import { withTmpDir } from "./helpers/tmp.js";
import { defined } from "./helpers/assert.js";
import { runAgent } from "../src/sdk/run-agent.js";
import { CapabilityError, ResolutionError } from "../src/errors.js";
import { InMemorySession } from "../src/builtins/session/memory.js";
import type { AgentManifest } from "../src/types/manifest.js";

const FIXTURES = path.resolve("test/fixtures");

function asSessionBinding(
  layer: ResolvedSessionLayer | undefined,
): SessionBinding {
  if (!layer || isPreBuiltSessionLayer(layer)) {
    throw new Error("expected a factory-backed SessionBinding");
  }
  return layer;
}

describe("manifest walk via runAgent", () => {
  it("resolves the file-based sample agent end-to-end", async () => {
    const agent = await runAgent(
      path.join(FIXTURES, "sample-agent/agent.toml"),
      {},
    );
    try {
      const tools = agent.agentState.toolTable.list().map((t) => t.name);
      expect(tools.sort()).toEqual([
        "edit_file",
        "find",
        "read_file",
        "write_file",
      ]);
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
    const layer0 = asSessionBinding(r.session?.[0]);
    const layer1 = asSessionBinding(r.session?.[1]);
    expect(layer0.factoryName).toBe("compacting");
    expect(layer0.config).toEqual({ threshold: 60 });
    expect(layer1.factoryName).toBe("in-memory");
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
    expect(asSessionBinding(r.session?.[0]).factoryName).toBe("in-memory");
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

  it("resolves [tools.X] entries through a configured-factory [providers] handle", () => {
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

    expect(r.tools).toHaveLength(2);
    const t0 = defined(r.tools[0]);
    const t1 = defined(r.tools[1]);
    expect(t0.toolName).toBe("read_text_file");
    expect(t1.toolName).toBe("list_directory");
    expect(t0.providerInstanceId).toBe(t1.providerInstanceId);

    const instance = defined(
      r.providers.find((p) => p.id === t0.providerInstanceId),
      "provider instance not found",
    );
    expect(instance.kind).toBe("provider");
    expect(instance.source).toBeUndefined();
    expect(instance.factoryName).toBe("test-meta");
    expect(instance.providerHandle).toBe("fs_mcp");
    expect(instance.config).toEqual({ npm: "@example/mcp-fs" });
    expect(instance.origin).toEqual({
      kind: "handle-factory",
      providerHandle: "fs_mcp",
      factoryName: "test-meta",
    });
  });

  it("keeps provider-level and per-tool config separate, deduping to one instance", () => {
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
    const t0 = defined(r.tools[0]);
    const t1 = defined(r.tools[1]);

    expect(t0.providerInstanceId).toBe(t1.providerInstanceId);
    const instance = defined(
      r.providers.find((p) => p.id === t0.providerInstanceId),
      "provider instance not found",
    );
    expect(instance.config).toEqual({
      npm: "@example/mcp-fs",
      shared: "from-provider",
    });

    expect(t0.toolConfig).toEqual({ flavour: "vanilla" });
    expect(t1.toolConfig).toEqual({ shared: "from-tool" });
  });

  it("dedupes tools pointing at the same configured-factory handle, even with different per-tool config", () => {
    const spec: AgentManifest = {
      name: "cf-dedup",
      systemPrompt: "x",
      harness: { provider: "test" },
      providers: {
        fs_mcp: { provider: "test-meta", npm: "@example/mcp-fs" },
      },
      tools: {
        a: { provider: "fs_mcp" },
        b: { provider: "fs_mcp", tool: "something_else" },
        c: { provider: "fs_mcp", note: "per-tool-only" },
      },
    };
    const r = resolveManifest(spec);
    const ids = new Set(r.tools.map((t) => t.providerInstanceId));
    expect(ids.size).toBe(1);
  });

  it("resolves [harness] through a configured-factory [providers] handle, with call-site config winning", () => {
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
    expect(r.harness?.source).toBeUndefined();
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
    const t0 = defined(r.tools[0]);
    const t1 = defined(r.tools[1]);
    const loaded = defined(
      r.providers.find((p) => p.id === t0.providerInstanceId),
      "loaded provider instance not found",
    );
    const configured = defined(
      r.providers.find((p) => p.id === t1.providerInstanceId),
      "configured provider instance not found",
    );

    expect(loaded.source).toEqual({ path: "./loaded-provider" });
    expect(loaded.factoryName).toBeUndefined();

    expect(configured.factoryName).toBe("test-meta");
    expect(configured.source).toBeUndefined();
  });

  it("resolves [agent].system_prompt as a file when path-like", async () => {
    await withTmpDir("loom-sp-path-", async (dir) => {
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
    });
  });
});
