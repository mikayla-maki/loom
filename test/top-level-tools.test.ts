/**
 * Tests for the top-level `[tools]` field on AgentManifest.
 *
 * Semantics under test:
 *   - field absent          → default builtin set auto-loads
 *   - field empty `{}`      → no top-level tools at all
 *   - field with entries    → exactly those, no defaults
 *   - top-level tools surface in audit with introducedBy === "(top-level)"
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { runAgent } from "../src/sdk/run-agent.js";
import { auditAgent, formatCapabilityTree } from "../src/audit/audit.js";
import type { AgentManifest, Capabilities } from "../src/types/manifest.js";
import type { TurnScript, TurnStep } from "../src/builtins/harness/test.js";
import type { Runtime } from "../src/types/interfaces.js";
import { echoTestProvider } from "./fixtures/echo-tool.js";

function buildAgent(opts: {
  tools?: AgentManifest["tools"];
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
  };
}

describe("top-level [tools]", () => {
  it("absent field auto-loads the default builtin set", async () => {
    const agent = await runAgent(buildAgent({}), {});
    try {
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
      buildAgent({
        tools: { bash: "builtin" },
        // bash requires `subprocess`; grant it.
        capabilities: { bash: { subprocess: "*" } },
      }),
      {},
    );
    try {
      const names = agent.agentState.toolTable.list().map((t) => t.name);
      expect(names).toEqual(["bash"]);
    } finally {
      await agent.close();
    }
  });

  it("explicit [tools] without [capabilities] gets nothing-but-smart-defaults", async () => {
    // When [tools] is declared explicitly, no default cap bundle
    // applies. Tools with no `requires` (read_file is `optional`,
    // not `requires`) construct fine and rely on smart defaults.
    // We pair read_file (a builtin) with echo from a test provider
    // to confirm the no-default-cap-bundle path doesn't trip up
    // either route.
    const agent = await runAgent(
      buildAgent({
        tools: { read_file: "builtin", echo: "builtin" },
        // No [capabilities] section at all.
      }),
      { providers: [echoTestProvider] },
    );
    try {
      const names = agent.agentState.toolTable.list().map((t) => t.name);
      expect(names.sort()).toEqual(["echo", "read_file"]);
      // read_file should describe its smart default in the description.
      const rf = agent.agentState.toolTable
        .list()
        .find((t) => t.name === "read_file");
      expect(rf?.description).toMatch(/smart default/);
    } finally {
      await agent.close();
    }
  });

  it("explicit [tools] with bash but no `subprocess` grant fails boot", async () => {
    // bash has `requires: ["subprocess"]`; without a grant, boot fails.
    await expect(
      runAgent(
        buildAgent({
          tools: { bash: "builtin" },
          capabilities: { bash: {} },
        }),
        {},
      ),
    ).rejects.toThrow(/missing required.*subprocess/);
  });

  it("audit: top-level tools show with a tools-table introducedBy label", async () => {
    const tree = await auditAgent(buildAgent({}));
    // v4: each tool's origin labels its `[tools.<name>]` block (or
    // `(default builtin)` for the auto-loaded set when [tools] is absent).
    expect(
      tree.tools.every(
        (t) =>
          t.introducedBy === "(default builtin)" ||
          t.introducedBy.startsWith("[tools."),
      ),
    ).toBe(true);
    const printed = formatCapabilityTree(tree);
    expect(printed).toMatch(/default builtin|\[tools\./);
  });

  it("system prompt: tools surface via Tool Reference", async () => {
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
    // Tools listed in the Tool Reference section.
    expect(captured).toContain("# Tool Reference");
    expect(captured).toMatch(/`bash`/);
    expect(captured).toMatch(/`read_file`/);
    expect(captured).toMatch(/`write_file`/);
    expect(captured).toMatch(/`find`/);
  });

  it("end-to-end: agent uses default tools (write_file then read_file)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-tlt-e2e-"));
    try {
      const target = path.join(root, "hello.txt");
      // The default tools are configured for "./" — i.e., process.cwd().
      // Override to root via [capabilities] so read/write are inside the grant.
      const agent = await runAgent(
        buildAgent({
          tools: {
            write_file: "builtin",
            read_file: "builtin",
          },
          capabilities: {
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
        const events = (await agent.session.pull?.([])) ?? [];
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
