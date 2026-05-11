import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import { TestHarness } from "../src/builtins/harness/test.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import type { Harness } from "../src/types/interfaces.js";

/**
 * `RunParameters` flow: callers pass per-turn knobs to `prompt()`; loom
 * forwards them to `harness.run()`. The harness owns interpretation —
 * the Anthropic harness translates `effort` → `output_config.effort`
 * and `thinking` → top-level `thinking`. Other harnesses can ignore.
 */

describe("RunParameters", () => {
  it("loom forwards params to the harness on each turn", async () => {
    const test = new TestHarness({});
    const harness: Harness = test;

    const agent = await runAgent({
      name: "params-forward",
      tools: {},
      harness,
    });
    try {
      await agent.prompt("a", { effort: "high" });
      expect(test.lastParams).toEqual({ effort: "high" });

      await agent.prompt("b", { effort: "low", maxOutputTokens: 256 });
      expect(test.lastParams).toEqual({
        effort: "low",
        maxOutputTokens: 256,
      });

      // No params → undefined arg.
      await agent.prompt("c");
      expect(test.lastParams).toBeUndefined();
    } finally {
      await agent.close();
    }
  });

  it("Anthropic harness translates effort + thinking + per-call model", async () => {
    let captured: Record<string, unknown> | null = null;
    const realFetch = global.fetch;
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v1/models/")) {
        const modelId = u.split("/v1/models/")[1] ?? "unknown";
        return new Response(
          JSON.stringify({ id: modelId, context_window: 200000 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      captured = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          id: "msg_1",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const agent = await runAgent(
        {
          name: "params-anthropic",
          tools: {},
          harness: {
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            stream: false,
          },
        },
        { secrets: new StaticSecretsStore({ ANTHROPIC_API_KEY: "k" }) },
      );
      try {
        // 1. effort alone → output_config.effort
        await agent.prompt("a", { effort: "high" });
        expect(captured).toMatchObject({
          model: "claude-sonnet-4-5",
          output_config: { effort: "high" },
        });
        expect(captured).not.toHaveProperty("thinking");

        // 2. thinking alone → top-level thinking
        const thinking = { type: "enabled", budget_tokens: 4096 };
        await agent.prompt("b", { thinking });
        expect(captured).toMatchObject({ thinking });
        expect(captured).not.toHaveProperty("output_config");

        // 3. Both → both appear; thinking takes semantic precedence.
        await agent.prompt("c", { effort: "max", thinking });
        expect(captured).toMatchObject({
          output_config: { effort: "max" },
          thinking,
        });

        // 4. Per-call model override.
        await agent.prompt("d", { model: "claude-haiku-4-5" });
        expect(captured).toMatchObject({ model: "claude-haiku-4-5" });

        // 5. maxOutputTokens override.
        await agent.prompt("e", { maxOutputTokens: 1024 });
        expect(captured).toMatchObject({ max_tokens: 1024 });
      } finally {
        await agent.close();
      }
    } finally {
      global.fetch = realFetch;
    }
  });
});
