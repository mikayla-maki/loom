import { afterEach, describe, expect, it } from "vitest";

import { runAgent } from "../src/sdk/run-agent.js";
import { TestHarness } from "../src/builtins/harness/test.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";

describe("RunParameters", () => {
  it("forwards per-turn params through to the harness", async () => {
    const test = new TestHarness({});

    const agent = await runAgent({
      name: "params-forward",
      tools: {},
      harness: test,
    });
    try {
      await agent.prompt("a", { effort: "high" });
      expect(test.lastParams).toEqual({ effort: "high" });

      await agent.prompt("b", { effort: "low", maxOutputTokens: 256 });
      expect(test.lastParams).toEqual({ effort: "low", maxOutputTokens: 256 });

      await agent.prompt("c");
      expect(test.lastParams).toBeUndefined();
    } finally {
      await agent.close();
    }
  });

  describe("Anthropic harness param translation", () => {
    const realFetch = global.fetch;
    afterEach(() => {
      global.fetch = realFetch;
    });

    it("translates effort, thinking, per-call model, and max tokens", async () => {
      // Body of the last messages request, so we can assert how params
      // were mapped onto the Anthropic wire format.
      let captured: Record<string, unknown> | null = null;
      global.fetch = (async (url: string | URL, init?: RequestInit) => {
        if (String(url).includes("/v1/models/")) {
          const modelId = String(url).split("/v1/models/")[1] ?? "unknown";
          return Response.json({ id: modelId, context_window: 200000 });
        }
        captured = init?.body ? JSON.parse(String(init.body)) : null;
        return Response.json({
          id: "msg_1",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 2 },
        });
      }) as typeof fetch;

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
        await agent.prompt("a", { effort: "high" });
        expect(captured).toMatchObject({
          model: "claude-sonnet-4-5",
          output_config: { effort: "high" },
        });
        expect(captured).not.toHaveProperty("thinking");

        const thinking = { type: "enabled", budget_tokens: 4096 };
        await agent.prompt("b", { thinking });
        expect(captured).toMatchObject({ thinking });
        expect(captured).not.toHaveProperty("output_config");

        await agent.prompt("c", { effort: "max", thinking });
        expect(captured).toMatchObject({
          output_config: { effort: "max" },
          thinking,
        });

        await agent.prompt("d", { model: "claude-haiku-4-5" });
        expect(captured).toMatchObject({ model: "claude-haiku-4-5" });

        await agent.prompt("e", { maxOutputTokens: 1024 });
        expect(captured).toMatchObject({ max_tokens: 1024 });
      } finally {
        await agent.close();
      }
    });
  });
});
