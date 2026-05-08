import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { resolveSystemPrompt } from "../src/manifest/resolver.js";
import { runAgent } from "../src/sdk/run-agent.js";
import { CapabilityError, ResolutionError } from "../src/errors.js";
import type { AgentManifest } from "../src/types/manifest.js";

const FIXTURES = path.resolve("test/fixtures");

describe("manifest walk via runAgent", () => {
  it("resolves the sample agent end-to-end", async () => {
    // The fixture stays file-based on purpose: exercises on-disk
    // system_prompt resolution and the per-tool [capabilities] check.
    const agent = await runAgent(
      path.join(FIXTURES, "sample-agent/agent.toml"),
      {},
    );
    try {
      const tools = agent.agentState.toolTable.list().map((t) => t.name);
      expect(tools.sort()).toEqual(["echo", "find", "read_file", "write_file"]);
      // Per-tool ceiling matches each tool's declared paths.
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

  it("rejects when a tool's caps exceed the per-tool sandbox ceiling", async () => {
    const spec: AgentManifest = {
      name: "snoopy",
      systemPrompt: "x",
      // read_file declares paths=["/etc"] — outside the ceiling's "./".
      tools: { read_file: { paths: ["/etc"] } },
      harness: { provider: "test" },
      capabilities: { read_file: { paths: ["./"] } },
    };
    await expect(runAgent(spec, {})).rejects.toThrow(CapabilityError);
  });

  it("fails when no provider claims a referenced tool name", async () => {
    const spec: AgentManifest = {
      name: "unknown-tool",
      systemPrompt: "x",
      tools: { not_a_real_tool: {} },
      harness: { provider: "test" },
    };
    await expect(runAgent(spec, {})).rejects.toThrow(ResolutionError);
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
provider = "memory"
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
