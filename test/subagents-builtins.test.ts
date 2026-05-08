import { describe, expect, it } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import { auditAgent, formatCapabilityTree } from "../src/audit/audit.js";
import { SpawnSubagentTool } from "../src/runtime/builtins/spawn_subagent.js";
import { AnthropicHarness } from "../src/extensions/harness/anthropic.js";
import { MemorySession } from "../src/extensions/session/memory.js";
import { forkOfParentSessionFactory } from "../src/extensions/session/parent-derived.js";
import { smallModelOfParentHarnessFactory } from "../src/extensions/harness/parent-derived.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type { Agent, ExtensionContext } from "../src/types/interfaces.js";
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
        // Pass the sub-manifest directly as the config.
        spawn_subagent: childManifest as unknown as Record<string, unknown>,
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
    const parentSession = new MemorySession();
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
    const ctx: ExtensionContext = {
      manifestDir: process.cwd(),
      agentName: "child",
      loomVersion: "test",
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
    ).rejects.toThrow(
      /Session provider 'fork-of-parent' requires a parent agent/,
    );
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
      /Harness provider 'small-model-of-parent' requires a parent agent/,
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
      session: new MemorySession(),
      systemPromptCore: "x",
      agentName: "parent",
    };
    const ctx: ExtensionContext = {
      manifestDir: process.cwd(),
      agentName: "child",
      loomVersion: "test",
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

  it("rejects parents that aren't AnthropicHarness with a helpful error", async () => {
    const parent: Agent = {
      harness: { run: async () => ({ stopReason: "end_turn" as const }) },
      session: new MemorySession(),
      systemPromptCore: "x",
      agentName: "parent",
    };
    const ctx: ExtensionContext = {
      manifestDir: process.cwd(),
      agentName: "child",
      loomVersion: "test",
    };
    await expect(async () =>
      smallModelOfParentHarnessFactory.create({ model: "x" }, ctx, {}, parent),
    ).rejects.toThrow(/AnthropicHarness/);
  });

  it("rejects missing model config with a helpful error", async () => {
    const parent: Agent = {
      harness: new AnthropicHarness(
        "claude",
        "fake-api-key",
        "https://api.anthropic.com",
        4096,
        16,
        true,
      ),
      session: new MemorySession(),
      systemPromptCore: "x",
      agentName: "parent",
    };
    const ctx: ExtensionContext = {
      manifestDir: process.cwd(),
      agentName: "child",
      loomVersion: "test",
    };
    await expect(async () =>
      smallModelOfParentHarnessFactory.create({}, ctx, {}, parent),
    ).rejects.toThrow(/`model`/);
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
        spawn_subagent: childManifest as unknown as Record<string, unknown>,
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
      spawn_subagent: recursive as unknown as Record<string, unknown>,
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
