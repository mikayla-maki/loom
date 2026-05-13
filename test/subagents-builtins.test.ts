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

describe("spawn_subagent builtin tool", () => {
  it("runs the configured sub-agent end-to-end and returns its final assistant message", async () => {
    const agent = await runAgent({
      name: "parent-using-builtin",
      systemPrompt: "x",
      tools: {
        // Pass the sub-manifest under `manifest` so the tool entry can
        // still carry the required `provider` field.
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
      const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
      expect(tu).toBeTruthy();
      if (tu && tu.sessionUpdate === "tool_call_update") {
        expect(tu.status).toBe("completed");
        const text =
          tu.content?.[0]?.type === "content" &&
          tu.content[0].content.type === "text"
            ? tu.content[0].content.text
            : "";
        expect(text).toBe("child-says-hello");
      }
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
      bash: { subprocess: "*" },
      spawn_subagent: "*",
    },
  };

  it("constructs without config when given the owning agent (clones its manifest)", () => {
    const owning: Agent = {
      manifest: parentManifest,
      harness: { run: async () => ({ stopReason: "end_turn" as const }) },
      session: { push: async () => [], pull: async () => [] },
      systemPromptCore: "x",
    };
    const tool = new SpawnSubagentTool({}, undefined, owning);
    expect(tool.isSelfCopy).toBe(true);
    expect(tool.dependencies.subagents).toHaveLength(1);
    const clone = tool.dependencies.subagents[0]!;
    expect(clone.name).toBe("parent-of-self");
    expect(clone.description).toBe("the original");
  });

  it("strips spawn_subagent from the clone's tools and capabilities", () => {
    const owning: Agent = {
      manifest: parentManifest,
      harness: { run: async () => ({ stopReason: "end_turn" as const }) },
      session: { push: async () => [], pull: async () => [] },
      systemPromptCore: "x",
    };
    const tool = new SpawnSubagentTool({}, undefined, owning);
    const clone = tool.dependencies.subagents[0]!;
    // Other tools survive; spawn_subagent is gone.
    expect(Object.keys(clone.tools ?? {}).sort()).toEqual(["bash"]);
    expect(Object.keys(clone.capabilities ?? {}).sort()).toEqual(["bash"]);
    // The parent's manifest is untouched (no in-place mutation).
    expect(Object.keys(parentManifest.tools ?? {}).sort()).toEqual([
      "bash",
      "spawn_subagent",
    ]);
  });

  it("uses the self-copy description", () => {
    const owning: Agent = {
      manifest: parentManifest,
      harness: { run: async () => ({ stopReason: "end_turn" as const }) },
      session: { push: async () => [], pull: async () => [] },
      systemPromptCore: "x",
    };
    const tool = new SpawnSubagentTool({}, undefined, owning);
    expect(tool.description).toBe(
      "Delegate a turn to a fresh copy of yourself.",
    );
  });

  it("prefers explicit config over the self-copy default", () => {
    const owning: Agent = {
      manifest: parentManifest,
      harness: { run: async () => ({ stopReason: "end_turn" as const }) },
      session: { push: async () => [], pull: async () => [] },
      systemPromptCore: "x",
    };
    const tool = new SpawnSubagentTool(
      { manifest: childManifest } as unknown as Record<string, unknown>,
      undefined,
      owning,
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
    // The parent and the clone share the same harness script (the
    // clone is a structural copy of the parent's manifest). Both
    // first emit a text message, then attempt to call
    // spawn_subagent, then end. The clone has spawn_subagent
    // stripped from its tool table — so the inner call surfaces as
    // an "Unknown tool" error in the child's session, but the
    // child's *final agent message* is the text it emitted before
    // that, which is what `spawn_subagent` returns to the parent.
    //
    // What we verify: the parent's `spawn_subagent` call completes
    // successfully and returns the clone's pre-call agent message.
    // That proves the clone was constructed, booted, and ran end
    // to end through `runAgent` with the parent's shape.
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
              // Don't echo the tool result back as an agent_message_chunk
              // — we want the child's `say` to remain the last agent
              // message in its session so `lastAgentMessage` picks it up.
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
      const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
      expect(tu).toBeTruthy();
      if (tu && tu.sessionUpdate === "tool_call_update") {
        expect(tu.status).toBe("completed");
        const text =
          tu.content?.[0]?.type === "content" &&
          tu.content[0].content.type === "text"
            ? tu.content[0].content.text
            : "";
        // The clone ran, emitted "from-cloned-agent", then failed
        // to find spawn_subagent in its (stripped) tool table. The
        // last agent message is what the clone reported.
        expect(text).toBe("from-cloned-agent");
      }
    } finally {
      await agent.close();
    }
  });

  describe("audit", () => {
    // Use an isolated LOOM_DATA_HOME so the audit walker's storage
    // resolution writes/reads .loom-agent in a tmpdir, not the real
    // user data home. This makes the storage-warning assertions
    // below deterministic across machines and test runs.
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

    it("a self-cloning agent doesn't infinite-loop (no recursion because clone has no spawn_subagent)", async () => {
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
      // One sub-agent in the tree: the cloned parent. No cycle marker,
      // because the clone has spawn_subagent stripped.
      expect(spawn!.subagents).toHaveLength(1);
      const cloneTree = spawn!.subagents[0]!;
      expect(cloneTree.name).toBe("self-cloner-audit");
      expect(
        cloneTree.tools.find((t) => t.name === "spawn_subagent"),
      ).toBeUndefined();
    });

    it("suppresses storage-collision warnings on sub-agents (only top-level shows them)", async () => {
      // The parent's manifestPath is `/virtual/self-cloner.toml`; the
      // clone's synthesized manifestPath is
      // `<self-copy:/virtual/self-cloner.toml>`. They share the same
      // storage dir (same name, no storageId override), so the
      // storage layer's collision detection fires when the audit
      // walker opens the clone's storage. Our filter clears that
      // warning on sub-agent nodes — only the top-level audit
      // surfaces actionable storage warnings.
      const m: AgentManifest = {
        name: "self-cloner-warn",
        manifestPath: "/virtual/self-cloner-warn.toml",
        systemPrompt: "x",
        harness: { provider: "test" },
        tools: { spawn_subagent: "builtin" },
        capabilities: { spawn_subagent: "*" },
      };
      const tree = await auditAgent(m);
      // First audit: top-level opens storage fresh; no prior
      // manifestPath recorded, so no collision warning at the top.
      // The clone opens second; would warn at the storage layer, but
      // the audit filter clears it on sub-agent nodes.
      const spawn = tree.tools.find((t) => t.name === "spawn_subagent")!;
      const cloneTree = spawn.subagents[0]!;
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
    const ctx: FactoryContext = {
      manifestDir: process.cwd(),
      agentName: "child",
      loomVersion: "test",
      clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
      storage: os.tmpdir(),
      metadata: {},
    };
    const child = await forkOfParentSessionFactory.create({}, ctx, {}, parent);

    // Child sees the parent's events …
    const childEvents = (await child.pull?.([])) ?? [];
    expect(childEvents).toHaveLength(2);

    // … but appending to the child doesn't bleed back to the parent.
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

  it("clones the parent's AnthropicHarness with the configured smaller model", async () => {
    const parentHarness = new AnthropicHarness(
      "claude-3-5-sonnet-latest",
      "fake-api-key",
      "https://api.anthropic.com",
      4096,
      16,
      true,
    );
    const parent: Agent = {
      manifest: { name: "parent", harness: { provider: "test" } },
      harness: parentHarness,
      session: new InMemorySession(),
      systemPromptCore: "x",
    };
    const ctx: FactoryContext = {
      manifestDir: process.cwd(),
      agentName: "child",
      loomVersion: "test",
      clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
      storage: os.tmpdir(),
      metadata: {},
    };
    const child = (await smallModelOfParentHarnessFactory.create(
      { model: "claude-3-5-haiku-latest" },
      ctx,
      {},
      parent,
    )) as AnthropicHarness;

    expect(child).toBeInstanceOf(AnthropicHarness);
    expect(child).not.toBe(parentHarness);

    // Read the private model field via cast so we can assert the new
    // value without spinning up the API.
    const childModel = (child as unknown as { model: string }).model;
    const childKey = (child as unknown as { apiKey: string }).apiKey;
    const parentKey = (parentHarness as unknown as { apiKey: string }).apiKey;
    expect(childModel).toBe("claude-3-5-haiku-latest");
    expect(childKey).toBe(parentKey);
  });

  it("works with any harness that implements the optional withModel() API", async () => {
    // OpenAIHarness implements `withModel` too, so the factory should
    // succeed with it as the parent — no special-case needed.
    const parentHarness = new OpenAIHarness(
      "gpt-4o",
      "fake-api-key",
      "https://api.openai.com/v1",
      4096,
      16,
      true,
    );
    const parent: Agent = {
      manifest: { name: "parent", harness: { provider: "test" } },
      harness: parentHarness,
      session: new InMemorySession(),
      systemPromptCore: "x",
    };
    const ctx: FactoryContext = {
      manifestDir: process.cwd(),
      agentName: "child",
      loomVersion: "test",
      clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
      storage: os.tmpdir(),
      metadata: {},
    };
    const child = (await smallModelOfParentHarnessFactory.create(
      { model: "gpt-4o-mini" },
      ctx,
      {},
      parent,
    )) as OpenAIHarness;

    expect(child).toBeInstanceOf(OpenAIHarness);
    expect(child).not.toBe(parentHarness);
    const childModel = (child as unknown as { model: string }).model;
    expect(childModel).toBe("gpt-4o-mini");
  });

  it("rejects parents whose harness has no withModel() method", async () => {
    // A bare Harness-shape object that satisfies the required `run`
    // method but doesn't implement the optional `withModel` API.
    const parent: Agent = {
      manifest: { name: "parent", harness: { provider: "test" } },
      harness: { run: async () => ({ stopReason: "end_turn" as const }) },
      session: new InMemorySession(),
      systemPromptCore: "x",
    };
    const ctx: FactoryContext = {
      manifestDir: process.cwd(),
      agentName: "child",
      loomVersion: "test",
      clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
      storage: os.tmpdir(),
      metadata: {},
    };
    await expect(async () =>
      smallModelOfParentHarnessFactory.create({ model: "x" }, ctx, {}, parent),
    ).rejects.toThrow(/withModel/);
  });

  it("falls back to the parent harness's smallModel() when no `model` is configured", async () => {
    // Parent uses claude-sonnet-4-5. The Anthropic harness's
    // smallModel() returns the in-family haiku variant, so the
    // sub-agent should boot without the manifest needing to specify
    // a model.
    const parentHarness = new AnthropicHarness(
      "claude-sonnet-4-5",
      "fake-api-key",
      "https://api.anthropic.com",
      4096,
      16,
      true,
    );
    const parent: Agent = {
      manifest: { name: "parent", harness: { provider: "test" } },
      harness: parentHarness,
      session: new InMemorySession(),
      systemPromptCore: "x",
    };
    const ctx: FactoryContext = {
      manifestDir: process.cwd(),
      agentName: "child",
      loomVersion: "test",
      clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
      storage: os.tmpdir(),
      metadata: {},
    };
    const child = (await smallModelOfParentHarnessFactory.create(
      {},
      ctx,
      {},
      parent,
    )) as AnthropicHarness;
    const childModel = (child as unknown as { model: string }).model;
    expect(childModel).toBe("claude-haiku-4-5");
  });

  it("errors helpfully when neither `model` nor smallModel() is available", async () => {
    // A bare Harness shape with `withModel` but no `smallModel`.
    const parent: Agent = {
      manifest: { name: "parent", harness: { provider: "test" } },
      harness: {
        run: async () => ({ stopReason: "end_turn" as const }),
        withModel(modelId: string) {
          return {
            run: async () => ({ stopReason: "end_turn" as const }),
            _model: modelId,
          } as unknown as ReturnType<
            NonNullable<Agent["harness"]["withModel"]>
          >;
        },
      },
      session: new InMemorySession(),
      systemPromptCore: "x",
    };
    const ctx: FactoryContext = {
      manifestDir: process.cwd(),
      agentName: "child",
      loomVersion: "test",
      clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
      storage: os.tmpdir(),
      metadata: {},
    };
    await expect(async () =>
      smallModelOfParentHarnessFactory.create({}, ctx, {}, parent),
    ).rejects.toThrow(/smallModel/);
  });
});

describe("Harness.smallModel built-in implementations", () => {
  it.each([
    ["claude-sonnet-4-5", "claude-haiku-4-5"],
    ["claude-opus-4-5", "claude-haiku-4-5"],
    // Haiku-family stays put: smallModel() is idempotent for the small variant.
    ["claude-haiku-4-5", "claude-haiku-4-5"],
  ])("AnthropicHarness: %s \u2192 %s", (model, expected) => {
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
    // Mini-family stays put.
    ["gpt-4o-mini", "gpt-4o-mini"],
  ])("OpenAIHarness: %s \u2192 %s", (model, expected) => {
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
      // The spawn_subagent builtin is opt-in; declaring it here pulls
      // its sub-manifest into the audit walk.
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

    // Pretty-printed output mentions both layers.
    const printed = formatCapabilityTree(tree);
    expect(printed).toContain("parent");
    expect(printed).toContain("spawn_subagent");
    expect(printed).toContain("child-builtin");
    expect(printed).toContain("sub-agent:");
  });

  it("detects cycles without infinite recursion", async () => {
    // A manifest whose spawn_subagent declares itself as the
    // sub-agent — a degenerate cycle. The recursion should bottom out
    // with a (cycle) marker rather than spinning.
    const recursive: AgentManifest = {
      name: "recursive",
      manifestPath: "/virtual/recursive.toml",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test" },
    };
    // The tool's sub-manifest is the same manifestPath as the parent
    // — that's the cycle.
    recursive.tools = {
      spawn_subagent: { provider: "builtin", manifest: recursive },
    };

    const tree = await auditAgent(recursive);
    const spawn = defined(
      tree.tools.find((t) => t.name === "spawn_subagent"),
      "spawn_subagent tool missing from audit tree",
    );
    expect(spawn.subagents).toHaveLength(1);
    // Cycle detection short-circuits the inner tree.
    const inner = defined(spawn.subagents[0], "missing inner sub-agent");
    expect(inner.unresolvedTools).toContainEqual(
      expect.objectContaining({ name: "(cycle)" }),
    );
    expect(inner.tools).toEqual([]);
  });
});
