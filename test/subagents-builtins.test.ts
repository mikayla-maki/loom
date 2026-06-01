import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { runAgent } from "../src/sdk/run-agent.js";
import { auditAgent, formatCapabilityTree } from "../src/audit/audit.js";
import { SpawnSubagentTool } from "../src/runtime/builtins/spawn_subagent.js";
import { AnthropicHarness } from "../src/builtins/harness/anthropic.js";
import { OpenAIHarness } from "../src/builtins/harness/openai.js";
import { InMemorySession } from "../src/builtins/session/memory.js";
import { forkOfParentSessionFactory } from "../src/builtins/session/parent-derived.js";
import { smallModelOfParentHarnessFactory } from "../src/builtins/harness/parent-derived.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type { Agent, FactoryContext } from "../src/types/interfaces.js";
import { DEFAULT_CLIENT_ACP_CAPABILITIES } from "../src/runtime/acp-capabilities.js";
import type { SessionUpdate } from "../src/types/acp.js";
import { defined } from "./helpers/assert.js";

const childManifest: AgentManifest = {
  name: "child-builtin",
  systemPrompt: "x",
  tools: {},
  harness: {
    provider: "test",
    script: [[{ say: "child-says-hello" }, { stop: "end_turn" }]],
  },
};

function factoryContext(): FactoryContext {
  return {
    manifestDir: process.cwd(),
    agentName: "child",
    loomVersion: "test",
    clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
    storage: os.tmpdir(),
    metadata: {},
  };
}

function completedToolCallText(events: SessionUpdate[]): string {
  const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
  expect(tu).toBeTruthy();
  if (!tu || tu.sessionUpdate !== "tool_call_update") return "";
  expect(tu.status).toBe("completed");
  return tu.content?.[0]?.type === "content" &&
    tu.content[0].content.type === "text"
    ? tu.content[0].content.text
    : "";
}

describe("spawn_subagent builtin tool", () => {
  it("runs the configured sub-agent end-to-end and returns its final assistant message", async () => {
    const agent = await runAgent({
      name: "parent-using-builtin",
      systemPrompt: "x",
      tools: {
        spawn_subagent: { provider: "builtin", manifest: childManifest },
      },
      harness: {
        provider: "test",
        script: [
          [
            {
              call: {
                tool: "spawn_subagent",
                input: { prompt: "go child go" },
              },
            },
            { stop: "end_turn" },
          ],
        ],
      },
    });
    try {
      await agent.prompt("go");
      const events = (await agent.session.pull?.([])) ?? [];
      expect(completedToolCallText(events)).toBe("child-says-hello");
    } finally {
      await agent.close();
    }
  });

  it("declares its sub-manifest in dependencies.subagents (so audit walks it)", () => {
    const tool = new SpawnSubagentTool(
      { manifest: childManifest } as unknown as Record<string, unknown>,
      undefined,
    );
    expect(tool.dependencies.subagents).toHaveLength(1);
    expect(tool.dependencies.subagents[0]?.name).toBe("child-builtin");
    expect(tool.isSelfCopy).toBe(false);
  });
});

describe("spawn_subagent self-copy default", () => {
  const parentManifest: AgentManifest = {
    name: "parent-of-self",
    description: "the original",
    systemPrompt: "be the parent",
    harness: {
      provider: "test",
      script: [[{ say: "parent-says-hi" }, { stop: "end_turn" }]],
    },
    tools: {
      spawn_subagent: "builtin",
      bash: "builtin",
    },
    capabilities: {
      bash: { commands: "*" },
      spawn_subagent: "*",
    },
  };

  function owningAgent(): Agent {
    return {
      manifest: parentManifest,
      harness: { run: async () => ({ stopReason: "end_turn" as const }) },
      session: { push: async () => [], pull: async () => [] },
      systemPromptCore: "x",
    };
  }

  it("clones the owning agent's manifest, strips spawn_subagent, and leaves the parent untouched", () => {
    const tool = new SpawnSubagentTool({}, undefined, owningAgent());

    expect(tool.isSelfCopy).toBe(true);
    expect(tool.description).toBe("Delegate a turn to a fresh copy of yourself.");
    expect(tool.dependencies.subagents).toHaveLength(1);

    const clone = tool.dependencies.subagents[0]!;
    expect(clone.name).toBe("parent-of-self");
    expect(clone.description).toBe("the original");
    expect(Object.keys(clone.tools ?? {}).sort()).toEqual(["bash"]);
    expect(Object.keys(clone.capabilities ?? {}).sort()).toEqual(["bash"]);
    expect(Object.keys(parentManifest.tools ?? {}).sort()).toEqual([
      "bash",
      "spawn_subagent",
    ]);
  });

  it("prefers explicit config over the self-copy default", () => {
    const tool = new SpawnSubagentTool(
      { manifest: childManifest } as unknown as Record<string, unknown>,
      undefined,
      owningAgent(),
    );
    expect(tool.isSelfCopy).toBe(false);
    expect(tool.subagentManifest.name).toBe("child-builtin");
  });

  it("throws when neither config nor parent manifest is available", () => {
    expect(() => new SpawnSubagentTool({}, undefined)).toThrow(
      /no sub-manifest available/,
    );
  });

  it("end-to-end: an agent with no manifest config spawns a working clone of itself", async () => {
    const m: AgentManifest = {
      name: "self-cloner",
      systemPrompt: "x",
      harness: {
        provider: "test",
        script: [
          [
            { say: "from-cloned-agent" },
            {
              call: {
                tool: "spawn_subagent",
                input: { prompt: "go" },
              },
              surface: false,
            },
            { stop: "end_turn" },
          ],
        ],
      },
      tools: { spawn_subagent: "builtin" },
      capabilities: { spawn_subagent: "*" },
    };
    const agent = await runAgent(m);
    try {
      await agent.prompt("go");
      const events = (await agent.session.pull?.([])) ?? [];
      expect(completedToolCallText(events)).toBe("from-cloned-agent");
    } finally {
      await agent.close();
    }
  });

  describe("audit", () => {
    let tmpDir = "";
    let prevDataHome: string | undefined;
    beforeAll(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-self-copy-"));
      prevDataHome = process.env.LOOM_DATA_HOME;
      process.env.LOOM_DATA_HOME = tmpDir;
    });
    afterAll(async () => {
      if (prevDataHome === undefined) {
        delete process.env.LOOM_DATA_HOME;
      } else {
        process.env.LOOM_DATA_HOME = prevDataHome;
      }
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("walks the self-clone without recursing and suppresses its storage warnings", async () => {
      const m: AgentManifest = {
        name: "self-cloner-audit",
        manifestPath: "/virtual/self-cloner.toml",
        systemPrompt: "x",
        harness: { provider: "test" },
        tools: { spawn_subagent: "builtin" },
        capabilities: { spawn_subagent: "*" },
      };
      const tree = await auditAgent(m);
      const spawn = tree.tools.find((t) => t.name === "spawn_subagent");
      expect(spawn).toBeTruthy();
      expect(spawn!.subagents).toHaveLength(1);

      const cloneTree = spawn!.subagents[0]!;
      expect(cloneTree.name).toBe("self-cloner-audit");
      expect(
        cloneTree.tools.find((t) => t.name === "spawn_subagent"),
      ).toBeUndefined();
      expect(cloneTree.storage.warnings).toEqual([]);
    });
  });
});

describe("fork-of-parent session", () => {
  it("seeds a fresh in-memory session with the parent's events at fork time", async () => {
    const parentSession = new InMemorySession();
    const u: SessionUpdate = {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "earlier" },
    };
    const a: SessionUpdate = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "earlier-reply" },
    };
    await parentSession.push(u);
    await parentSession.push(a);

    const parent: Agent = {
      manifest: { name: "parent", harness: { provider: "test" } },
      harness: { run: async () => ({ stopReason: "end_turn" as const }) },
      session: parentSession,
      systemPromptCore: "core",
    };
    const child = await forkOfParentSessionFactory.create(
      {},
      factoryContext(),
      {},
      parent,
    );

    const childEvents = (await child.pull?.([])) ?? [];
    expect(childEvents).toHaveLength(2);

    await Promise.resolve(
      child.push?.({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "child-only" },
      }),
    );
    expect(((await child.pull?.([])) ?? []).length).toBe(3);
    expect((await parentSession.pull([])).length).toBe(2);
  });

  it("requiresParent: top-level boot fails with a clear error", async () => {
    await expect(
      runAgent({
        name: "top",
        systemPrompt: "x",
        tools: {},
        harness: { provider: "test" },
        session: { provider: "fork-of-parent" },
      }),
    ).rejects.toThrow(/Session 'fork-of-parent' requires a parent agent/);
  });
});

describe("small-model-of-parent harness", () => {
  function parentWith(harness: Agent["harness"]): Agent {
    return {
      manifest: { name: "parent", harness: { provider: "test" } },
      harness,
      session: new InMemorySession(),
      systemPromptCore: "x",
    };
  }

  it("requiresParent: top-level boot fails with a clear error", async () => {
    await expect(
      runAgent({
        name: "top",
        systemPrompt: "x",
        tools: {},
        harness: { provider: "small-model-of-parent", model: "tiny" },
      }),
    ).rejects.toThrow(
      /Harness 'small-model-of-parent' requires a parent agent/,
    );
  });

  it("clones the parent's AnthropicHarness with the configured smaller model, reusing the parent's key", async () => {
    const parentHarness = new AnthropicHarness(
      "claude-3-5-sonnet-latest",
      "fake-api-key",
      "https://api.anthropic.com",
      4096,
      16,
      true,
    );
    const child = (await smallModelOfParentHarnessFactory.create(
      { model: "claude-3-5-haiku-latest" },
      factoryContext(),
      {},
      parentWith(parentHarness),
    )) as AnthropicHarness;

    expect(child).toBeInstanceOf(AnthropicHarness);
    expect(child).not.toBe(parentHarness);
    const childModel = (child as unknown as { model: string }).model;
    const childKey = (child as unknown as { apiKey: string }).apiKey;
    const parentKey = (parentHarness as unknown as { apiKey: string }).apiKey;
    expect(childModel).toBe("claude-3-5-haiku-latest");
    expect(childKey).toBe(parentKey);
  });

  it("works with any harness that implements the optional withModel() API", async () => {
    const parentHarness = new OpenAIHarness(
      "gpt-4o",
      "fake-api-key",
      "https://api.openai.com/v1",
      4096,
      16,
      true,
    );
    const child = (await smallModelOfParentHarnessFactory.create(
      { model: "gpt-4o-mini" },
      factoryContext(),
      {},
      parentWith(parentHarness),
    )) as OpenAIHarness;

    expect(child).toBeInstanceOf(OpenAIHarness);
    expect(child).not.toBe(parentHarness);
    const childModel = (child as unknown as { model: string }).model;
    expect(childModel).toBe("gpt-4o-mini");
  });

  it("rejects parents whose harness has no withModel() method", async () => {
    const parent = parentWith({
      run: async () => ({ stopReason: "end_turn" as const }),
    });
    await expect(async () =>
      smallModelOfParentHarnessFactory.create(
        { model: "x" },
        factoryContext(),
        {},
        parent,
      ),
    ).rejects.toThrow(/withModel/);
  });

  it("falls back to the parent harness's smallModel() when no `model` is configured", async () => {
    const parentHarness = new AnthropicHarness(
      "claude-sonnet-4-5",
      "fake-api-key",
      "https://api.anthropic.com",
      4096,
      16,
      true,
    );
    const child = (await smallModelOfParentHarnessFactory.create(
      {},
      factoryContext(),
      {},
      parentWith(parentHarness),
    )) as AnthropicHarness;
    const childModel = (child as unknown as { model: string }).model;
    expect(childModel).toBe("claude-haiku-4-5");
  });

  it("errors helpfully when neither `model` nor smallModel() is available", async () => {
    const parent = parentWith({
      run: async () => ({ stopReason: "end_turn" as const }),
      withModel(modelId: string) {
        return {
          run: async () => ({ stopReason: "end_turn" as const }),
          _model: modelId,
        } as unknown as ReturnType<NonNullable<Agent["harness"]["withModel"]>>;
      },
    });
    await expect(async () =>
      smallModelOfParentHarnessFactory.create({}, factoryContext(), {}, parent),
    ).rejects.toThrow(/smallModel/);
  });
});

describe("Harness.smallModel built-in implementations", () => {
  it.each([
    ["claude-sonnet-4-5", "claude-haiku-4-5"],
    ["claude-opus-4-5", "claude-haiku-4-5"],
    ["claude-haiku-4-5", "claude-haiku-4-5"],
  ])("AnthropicHarness: %s → %s", (model, expected) => {
    const h = new AnthropicHarness(
      model,
      "k",
      "https://api.anthropic.com",
      4096,
      16,
      true,
    );
    expect(h.smallModel()).toBe(expected);
  });

  it.each([
    ["gpt-4o", "gpt-4o-mini"],
    ["o1", "o1-mini"],
    ["gpt-4o-mini", "gpt-4o-mini"],
  ])("OpenAIHarness: %s → %s", (model, expected) => {
    const h = new OpenAIHarness(
      model,
      "k",
      "https://api.openai.com/v1",
      4096,
      16,
      true,
    );
    expect(h.smallModel()).toBe(expected);
  });
});

describe("loom audit recursion", () => {
  it("walks tool.dependencies.subagents and reports the descendants", async () => {
    const tree = await auditAgent({
      name: "parent",
      systemPrompt: "x",
      tools: {
        spawn_subagent: { provider: "builtin", manifest: childManifest },
      },
      harness: { provider: "test" },
    });

    expect(tree.name).toBe("parent");
    const spawn = defined(
      tree.tools.find((t) => t.name === "spawn_subagent"),
      "spawn_subagent tool missing from audit tree",
    );
    expect(spawn.subagents).toHaveLength(1);
    expect(spawn.subagents[0]?.name).toBe("child-builtin");

    const printed = formatCapabilityTree(tree);
    expect(printed).toContain("parent");
    expect(printed).toContain("spawn_subagent");
    expect(printed).toContain("child-builtin");
    expect(printed).toContain("sub-agent:");
  });

  it("detects cycles without infinite recursion", async () => {
    const recursive: AgentManifest = {
      name: "recursive",
      manifestPath: "/virtual/recursive.toml",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test" },
    };
    recursive.tools = {
      spawn_subagent: { provider: "builtin", manifest: recursive },
    };

    const tree = await auditAgent(recursive);
    const spawn = defined(
      tree.tools.find((t) => t.name === "spawn_subagent"),
      "spawn_subagent tool missing from audit tree",
    );
    expect(spawn.subagents).toHaveLength(1);
    const inner = defined(spawn.subagents[0], "missing inner sub-agent");
    expect(inner.unresolvedTools).toContainEqual(
      expect.objectContaining({ name: "(cycle)" }),
    );
    expect(inner.tools).toEqual([]);
  });
});
