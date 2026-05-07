/**
 * Tests for the top-level `[tools]` field on AgentManifest.
 *
 * Semantics under test:
 *   - field absent          → default builtin set auto-loads
 *   - field empty `{}`      → no top-level tools at all
 *   - field with entries    → exactly those, no defaults
 *   - collision with skill's `requires` → hard error
 *   - top-level tools surface in audit with introducedBy === "(top-level)"
 *   - system prompt does NOT inline a "core skill" body any more
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { runAgent } from "../src/sdk/run-agent.js";
import { auditAgent, formatCapabilityTree } from "../src/audit/audit.js";
import type { AgentManifest, Capabilities } from "../src/types/manifest.js";
import type { TurnScript, TurnStep } from "../src/extensions/harness/test.js";
import type { Runtime } from "../src/types/interfaces.js";

function buildAgent(opts: {
  tools?: AgentManifest["tools"];
  skills?: AgentManifest["skills"];
  capabilities?: Capabilities;
  systemPrompt?: string;
  harnessScript?:
    | TurnScript[]
    | ((rt: Runtime, turnIndex: number) => Promise<TurnStep[]> | TurnStep[]);
}): AgentManifest {
  return {
    name: "demo",
    systemPrompt: opts.systemPrompt ?? "be brief",
    harness: {
      provider: "test",
      ...(opts.harnessScript ? { script: opts.harnessScript } : {}),
    },
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(opts.skills ? { skills: opts.skills } : {}),
  };
}

describe("top-level [tools]", () => {
  it("absent field auto-loads the default builtin set", async () => {
    const agent = await runAgent(buildAgent({}), {});
    try {
      expect(agent.agentState.skills).toHaveLength(0);
      const names = agent.agentState.toolTable
        .list()
        .map((t) => t.name)
        .sort();
      expect(names).toEqual(["bash", "find", "read_file", "write_file"]);
    } finally {
      await agent.close();
    }
  });

  it("empty `{}` opts out of all top-level tools", async () => {
    const agent = await runAgent(buildAgent({ tools: {} }), {});
    try {
      expect(agent.agentState.toolTable.list()).toHaveLength(0);
    } finally {
      await agent.close();
    }
  });

  it("explicit list replaces the defaults exactly", async () => {
    const agent = await runAgent(
      buildAgent({ tools: { bash: "builtin" } }),
      {},
    );
    try {
      const names = agent.agentState.toolTable.list().map((t) => t.name);
      expect(names).toEqual(["bash"]);
    } finally {
      await agent.close();
    }
  });

  it("top-level + skill is additive (skill brings extra tools alongside top-level)", async () => {
    const agent = await runAgent(
      buildAgent({
        tools: { bash: "builtin" },
        skills: {
          extra: {
            description: "extra tool",
            requires: { read_file: { paths: ["./"] } },
          },
        },
      }),
      {},
    );
    try {
      const names = agent.agentState.toolTable
        .list()
        .map((t) => t.name)
        .sort();
      expect(names).toEqual(["bash", "read_file"]);
    } finally {
      await agent.close();
    }
  });

  it("name collision between top-level and a skill's requires is a hard error", async () => {
    await expect(
      runAgent(
        buildAgent({
          tools: { bash: "builtin" },
          skills: {
            shell: {
              description: "shell access",
              requires: { bash: "builtin" },
            },
          },
        }),
        {},
      ),
    ).rejects.toThrow(/declared at the top level AND brought in by skill/);
  });

  it("default tool set requires the per-tool ceiling to allow './'", async () => {
    // No top-level [tools] declaration → defaults load → read_file/write_file/find
    // declare paths=['./']; a tighter per-tool ceiling fails.
    await expect(
      runAgent(
        buildAgent({
          // Per-tool ceiling that disallows the project root for read_file.
          capabilities: { read_file: { paths: ["/nonexistent"] } },
        }),
        {},
      ),
    ).rejects.toThrow(/exceed.*ceiling/i);
  });

  it("audit: top-level tools show with introducedBy === '(top-level)' and render in output", async () => {
    const tree = await auditAgent(buildAgent({}));
    expect(tree.tools.every((t) => t.introducedBy === "(top-level)")).toBe(
      true,
    );
    const printed = formatCapabilityTree(tree);
    expect(printed).toMatch(/from \(top-level\)/);
  });

  it("system prompt no longer inlines a core-skill body; default tools surface only via Tool Reference", async () => {
    let captured = "";
    const agent = await runAgent(
      buildAgent({
        systemPrompt: "You are a focused engineer.",
        harnessScript: async (rt: Runtime) => {
          captured = rt.systemPrompt();
          return [{ stop: "end_turn" }];
        },
      }),
      {},
    );
    try {
      await agent.prompt("hi");
    } finally {
      await agent.close();
    }
    expect(captured).toContain("You are a focused engineer.");
    // The core-skill body's old text must not appear (no inline section).
    expect(captured).not.toContain("Core file & shell tools");
    expect(captured).not.toMatch(/##\s+core\b/);
    // Tools still listed in the Tool Reference section.
    expect(captured).toContain("# Tool Reference");
    expect(captured).toMatch(/`bash`/);
    expect(captured).toMatch(/`read_file`/);
    expect(captured).toMatch(/`write_file`/);
    expect(captured).toMatch(/`find`/);
    // No # Available Skills section since this agent declared no skills.
    expect(captured).not.toContain("# Available Skills");
  });

  it("end-to-end: agent uses default tools (write_file then read_file)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-tlt-e2e-"));
    try {
      const target = path.join(root, "hello.txt");
      // The default tools are configured for "./" — i.e., process.cwd().
      // Override to root so the read/write paths are inside the ceiling.
      const agent = await runAgent(
        buildAgent({
          tools: {
            write_file: { paths: [root] },
            read_file: { paths: [root] },
          },
          harnessScript: [
            [
              {
                call: {
                  tool: "write_file",
                  input: { path: target, content: "from-defaults" },
                },
              },
              {
                call: { tool: "read_file", input: { path: target } },
                surface: true,
              },
              { stop: "end_turn" },
            ],
          ],
        }),
        {},
      );
      try {
        await agent.prompt("go");
        const events = await agent.session.getEvents();
        const tcus = events.filter(
          (e) => e.sessionUpdate === "tool_call_update",
        );
        expect(tcus).toHaveLength(2);
        const readResult = tcus[1];
        if (readResult && readResult.sessionUpdate === "tool_call_update") {
          expect(readResult.status).toBe("completed");
          const text =
            readResult.content?.[0]?.type === "content" &&
            readResult.content[0].content.type === "text"
              ? readResult.content[0].content.text
              : "";
          expect(text).toBe("from-defaults");
        }
      } finally {
        await agent.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
