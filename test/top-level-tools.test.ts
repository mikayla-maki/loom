import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

import { runAgent } from "../src/sdk/run-agent.js";
import { auditAgent, formatCapabilityTree } from "../src/audit/audit.js";
import type { AgentManifest, Capabilities } from "../src/types/manifest.js";
import type { TurnScript, TurnStep } from "../src/builtins/harness/test.js";
import type { Runtime } from "../src/types/interfaces.js";
import { echoTestProvider } from "./fixtures/echo-tool.js";
import { withTmpDir } from "./helpers/tmp.js";
import { defined } from "./helpers/assert.js";

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

type Agent = Awaited<ReturnType<typeof runAgent>>;

function toolNames(agent: Agent): string[] {
  return agent.agentState.toolTable
    .list()
    .map((t) => t.name)
    .sort();
}

async function withAgent<T>(
  agent: Promise<Agent>,
  fn: (agent: Agent) => Promise<T>,
): Promise<T> {
  const a = await agent;
  try {
    return await fn(a);
  } finally {
    await a.close();
  }
}

describe("top-level [tools]", () => {
  it("absent field auto-loads the default builtin set", async () => {
    const agent = await runAgent(buildAgent({}), {});
    try {
      expect(toolNames(agent)).toEqual([
        "bash",
        "edit_file",
        "read_file",
        "write_file",
      ]);
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
        capabilities: { bash: { commands: "*" } },
      }),
      {},
    );
    try {
      expect(toolNames(agent)).toEqual(["bash"]);
    } finally {
      await agent.close();
    }
  });

  it("explicit [tools] without [capabilities] grants from the default ceiling", async () => {
    const agent = await runAgent(
      buildAgent({ tools: { read_file: "builtin", echo: "builtin" } }),
      { providers: [echoTestProvider] },
    );
    try {
      expect(toolNames(agent)).toEqual(["echo", "read_file"]);
      // Skill reads go through read_skill, so the default ceiling is just
      // cwd — no ambient skills-root widening.
      expect(agent.capabilities.read_file).toEqual({ paths: ["./"] });
      const rf = agent.agentState.toolTable
        .list()
        .find((t) => t.name === "read_file");
      expect(rf?.description).toBe(
        `Read a UTF-8 file from disk (restricted to: ${path.resolve(".")}).`,
      );
    } finally {
      await agent.close();
    }
  });

  it("explicit [tools] with bash but no `commands` grant fails boot", async () => {
    await expect(
      runAgent(
        buildAgent({ tools: { bash: "builtin" }, capabilities: { bash: {} } }),
        {},
      ),
    ).rejects.toThrow(/missing required.*commands/);
  });

  it("audit: top-level tools carry a tools-table introducedBy label on the tree", async () => {
    const tree = await auditAgent(buildAgent({}));
    expect(
      tree.tools.every(
        (t) =>
          t.introducedBy === "(default builtin)" ||
          t.introducedBy.startsWith("[tools."),
      ),
    ).toBe(true);
    const printed = formatCapabilityTree(tree, { color: false });
    expect(printed).toMatch(/\bbash\s+via\s+/);
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
    expect(captured).toContain("# Tool Reference");
    expect(captured).toMatch(/`bash`/);
    expect(captured).toMatch(/`read_file`/);
    expect(captured).toMatch(/`write_file`/);
    expect(captured).toMatch(/`edit_file`/);
  });

  it("end-to-end: agent uses default tools (write_file then read_file)", async () => {
    await withTmpDir("loom-tlt-e2e-", async (root) => {
      const target = path.join(root, "hello.txt");
      const agent = await runAgent(
        buildAgent({
          tools: { write_file: "builtin", read_file: "builtin" },
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
    });
  });
});
