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
import { resolveAgent } from "../src/manifest/resolver.js";
import { auditAgent, formatCapabilityTree } from "../src/audit/audit.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type { TurnScript, TurnStep } from "../src/extensions/harness/test.js";
import type { Runtime } from "../src/types/interfaces.js";

function buildAgent(opts: {
  tools?: AgentManifest["tools"];
  skills?: AgentManifest["skills"];
  filesystem?: string[];
  systemPrompt?: string;
  harnessScript?:
    | TurnScript[]
    | ((rt: Runtime, turnIndex: number) => Promise<TurnStep[]> | TurnStep[]);
}): AgentManifest {
  const sandbox = {
    filesystem: opts.filesystem ?? ["./"],
    network: [],
    secrets: [],
  };
  return {
    name: "demo",
    systemPrompt: opts.systemPrompt ?? "be brief",
    harness: {
      provider: "test",
      ...(opts.harnessScript ? { script: opts.harnessScript } : {}),
    },
    sandbox,
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(opts.skills ? { skills: opts.skills } : {}),
  };
}

describe("top-level [tools]", () => {
  it("absent field auto-loads the default builtin set", async () => {
    const r = await resolveAgent(buildAgent({}));
    // No skills, but tools[] still has the defaults.
    expect(r.skills).toHaveLength(0);
    expect(r.tools.map((t) => t.manifest.name).sort()).toEqual([
      "bash",
      "find",
      "read_file",
      "write_file",
    ]);
    expect(r.tools.every((t) => t.introducedBy === "(top-level)")).toBe(true);
  });

  it("empty `{}` opts out of all top-level tools", async () => {
    const r = await resolveAgent(buildAgent({ tools: {} }));
    expect(r.tools).toHaveLength(0);
  });

  it("explicit list replaces the defaults exactly", async () => {
    const r = await resolveAgent(buildAgent({ tools: { bash: "builtin" } }));
    expect(r.tools.map((t) => t.manifest.name)).toEqual(["bash"]);
    expect(r.tools[0]?.introducedBy).toBe("(top-level)");
  });

  it("top-level + skill is additive (skill brings extra tools alongside top-level)", async () => {
    const r = await resolveAgent(
      buildAgent({
        tools: { bash: "builtin" },
        skills: {
          extra: {
            description: "extra tool",
            requires: { read_file: "builtin" },
          },
        },
      }),
    );
    expect(r.tools.map((t) => t.manifest.name).sort()).toEqual([
      "bash",
      "read_file",
    ]);
    const top = r.tools.find((t) => t.manifest.name === "bash");
    const sk = r.tools.find((t) => t.manifest.name === "read_file");
    expect(top?.introducedBy).toBe("(top-level)");
    expect(sk?.introducedBy).toBe("extra");
  });

  it("name collision between top-level and a skill's requires is a hard error", async () => {
    await expect(
      resolveAgent(
        buildAgent({
          tools: { bash: "builtin" },
          skills: {
            shell: {
              description: "shell access",
              requires: { bash: "builtin" },
            },
          },
        }),
      ),
    ).rejects.toThrow(/declared at the top level AND brought in by skill/);
  });

  it("inline tool spec at top level resolves directly", async () => {
    const r = await resolveAgent(
      buildAgent({
        tools: {
          custom: {
            description: "custom inline",
            schema: { type: "object" },
            invocation: { command: "echo" },
            capabilities: { filesystem: [], network: [] },
          },
        },
      }),
    );
    expect(r.tools.map((t) => t.manifest.name)).toEqual(["custom"]);
    expect(r.tools[0]?.introducedBy).toBe("(top-level)");
  });

  it("default tool set requires filesystem = ['./'] in [sandbox]", async () => {
    // No top-level [tools] declaration → defaults load → bash etc.
    // declare filesystem='./'; an empty filesystem ceiling fails the
    // capability check.
    await expect(
      resolveAgent(buildAgent({ filesystem: [] })),
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
      const agent = await runAgent(
        buildAgent({
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
