import { describe, expect, it } from "vitest";
import * as os from "node:os";

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
      harness: { run: async () => ({ stopReason: "end_turn" as const }) },
      session: parentSession,
      systemPromptCore: "core",
      agentName: "parent",
    };
    const ctx: FactoryContext = {
      manifestDir: process.cwd(),
      agentName: "child",
      loomVersion: "test",
      clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
      storage: os.tmpdir(),
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
      harness: parentHarness,
      session: new InMemorySession(),
      systemPromptCore: "x",
      agentName: "parent",
    };
    const ctx: FactoryContext = {
      manifestDir: process.cwd(),
      agentName: "child",
      loomVersion: "test",
      clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
      storage: os.tmpdir(),
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
      harness: parentHarness,
      session: new InMemorySession(),
      systemPromptCore: "x",
      agentName: "parent",
    };
    const ctx: FactoryContext = {
      manifestDir: process.cwd(),
      agentName: "child",
      loomVersion: "test",
      clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
      storage: os.tmpdir(),
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
      harness: { run: async () => ({ stopReason: "end_turn" as const }) },
      session: new InMemorySession(),
      systemPromptCore: "x",
      agentName: "parent",
    };
    const ctx: FactoryContext = {
      manifestDir: process.cwd(),
      agentName: "child",
      loomVersion: "test",
      clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
      storage: os.tmpdir(),
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
      harness: parentHarness,
      session: new InMemorySession(),
      systemPromptCore: "x",
      agentName: "parent",
    };
    const ctx: FactoryContext = {
      manifestDir: process.cwd(),
      agentName: "child",
      loomVersion: "test",
      clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
      storage: os.tmpdir(),
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
      agentName: "parent",
    };
    const ctx: FactoryContext = {
      manifestDir: process.cwd(),
      agentName: "child",
      loomVersion: "test",
      clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
      storage: os.tmpdir(),
    };
    await expect(async () =>
      smallModelOfParentHarnessFactory.create({}, ctx, {}, parent),
    ).rejects.toThrow(/smallModel/);
  });
});

describe("Harness.smallModel built-in implementations", () => {
  it("AnthropicHarness maps sonnet \u2192 haiku in-family", () => {
    const h = new AnthropicHarness(
      "claude-sonnet-4-5",
      "k",
      "https://api.anthropic.com",
      4096,
      16,
      true,
    );
    expect(h.smallModel()).toBe("claude-haiku-4-5");
  });

  it("AnthropicHarness maps opus \u2192 haiku in-family", () => {
    const h = new AnthropicHarness(
      "claude-opus-4-5",
      "k",
      "https://api.anthropic.com",
      4096,
      16,
      true,
    );
    expect(h.smallModel()).toBe("claude-haiku-4-5");
  });

  it("AnthropicHarness leaves haiku-family models unchanged", () => {
    const h = new AnthropicHarness(
      "claude-haiku-4-5",
      "k",
      "https://api.anthropic.com",
      4096,
      16,
      true,
    );
    expect(h.smallModel()).toBe("claude-haiku-4-5");
  });

  it("OpenAIHarness maps gpt-4o \u2192 gpt-4o-mini", () => {
    const h = new OpenAIHarness(
      "gpt-4o",
      "k",
      "https://api.openai.com/v1",
      4096,
      16,
      true,
    );
    expect(h.smallModel()).toBe("gpt-4o-mini");
  });

  it("OpenAIHarness maps o1 \u2192 o1-mini", () => {
    const h = new OpenAIHarness(
      "o1",
      "k",
      "https://api.openai.com/v1",
      4096,
      16,
      true,
    );
    expect(h.smallModel()).toBe("o1-mini");
  });

  it("OpenAIHarness leaves mini-family models unchanged", () => {
    const h = new OpenAIHarness(
      "gpt-4o-mini",
      "k",
      "https://api.openai.com/v1",
      4096,
      16,
      true,
    );
    expect(h.smallModel()).toBe("gpt-4o-mini");
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
    const spawn = tree.tools.find((t) => t.name === "spawn_subagent");
    expect(spawn).toBeDefined();
    expect(spawn!.subagents).toHaveLength(1);
    expect(spawn!.subagents[0]?.name).toBe("child-builtin");

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
    const spawn = tree.tools.find((t) => t.name === "spawn_subagent");
    expect(spawn).toBeDefined();
    expect(spawn!.subagents).toHaveLength(1);
    // Cycle detection short-circuits the inner tree.
    const inner = spawn!.subagents[0]!;
    expect(inner.unresolvedTools).toContainEqual(
      expect.objectContaining({ name: "(cycle)" }),
    );
    expect(inner.tools).toEqual([]);
  });
});
