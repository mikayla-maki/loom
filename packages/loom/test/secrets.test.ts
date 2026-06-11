import { describe, expect, it } from "vitest";

import { runAgent, StaticSecretsStore } from "../src/sdk/run-agent.js";
import { SecretError } from "../src/errors.js";
import { defined } from "./helpers/assert.js";
import type {
  FactoryContext,
  Harness,
  HarnessFactory,
  Tools,
  Runtime,
  Tool,
} from "../src/types/interfaces.js";
import { registerHarness } from "../src/builtins/index.js";

const capturedByHarness = new Map<string, Record<string, string>>();
const captureFactory: HarnessFactory = {
  name: "capture",
  secrets: { required: ["CAPTURE_REQUIRED"], optional: ["CAPTURE_OPTIONAL"] },
  create(
    _config: Record<string, unknown>,
    ctx: FactoryContext,
    secrets: Record<string, string>,
  ): Harness {
    capturedByHarness.set(String(ctx.agentName), { ...secrets });
    return {
      async run(rt: Runtime) {
        await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return { stopReason: "end_turn" as const };
      },
    };
  },
};
registerHarness(captureFactory);

async function runCapture(
  name: string,
  options: Parameters<typeof runAgent>[1],
): Promise<Record<string, string> | undefined> {
  capturedByHarness.clear();
  const agent = await runAgent(
    { name, tools: {}, harness: { provider: "capture" } },
    options,
  );
  try {
    return capturedByHarness.get(name);
  } finally {
    await agent.close();
  }
}

describe("secrets pipeline", () => {
  it("a factory receives only its declared secrets, present-or-absent per its allowlist", async () => {
    const full = await runCapture("factory-slice", {
      secrets: new StaticSecretsStore({
        CAPTURE_REQUIRED: "rv",
        CAPTURE_OPTIONAL: "ov",
        UNRELATED: "should-not-appear",
      }),
    });
    expect(full).toEqual({ CAPTURE_REQUIRED: "rv", CAPTURE_OPTIONAL: "ov" });

    const optionalMissing = await runCapture("optional-missing", {
      secrets: new StaticSecretsStore({ CAPTURE_REQUIRED: "rv" }),
    });
    expect(optionalMissing).toEqual({ CAPTURE_REQUIRED: "rv" });
  });

  it("missing required secret throws SecretError naming the requester", async () => {
    await expect(
      runAgent(
        { name: "missing-required", tools: {}, harness: { provider: "capture" } },
        { secrets: new StaticSecretsStore({}) },
      ),
    ).rejects.toThrow(/CAPTURE_REQUIRED.*harness:capture/s);
  });

  it("a tool only sees its own declared secrets at execute time", async () => {
    const probe = (name: string, declared: string[]): Tool => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      secrets: { required: declared },
      async execute(_input, ctx) {
        const out: Record<string, string | null> = {};
        for (const k of ["A_TOKEN", "B_TOKEN", "SHARED"]) {
          out[k] = ctx.secrets[k] ?? null;
        }
        return { content: JSON.stringify(out) };
      },
    });
    const toolA = probe("tool_a", ["A_TOKEN", "SHARED"]);
    const toolB = probe("tool_b", ["B_TOKEN", "SHARED"]);
    const provider: Tools = {
      resolveTool(name) {
        if (name === "tool_a") return toolA;
        if (name === "tool_b") return toolB;
        return null;
      },
      close() {},
    };

    const agent = await runAgent(
      {
        name: "secret-iso",
        tools: { tool_a: "builtin", tool_b: "builtin" },
        harness: {
          provider: "test",
          script: [
            [
              { call: { tool: "tool_a", input: {} }, surface: false },
              { call: { tool: "tool_b", input: {} }, surface: false },
              { stop: "end_turn" },
            ],
          ],
        },
      },
      {
        providers: [provider],
        secrets: new StaticSecretsStore({
          A_TOKEN: "AAA",
          B_TOKEN: "BBB",
          SHARED: "SSS",
        }),
      },
    );
    try {
      await agent.prompt("go");
      const events = (await agent.session.pull?.([])) ?? [];
      const tcus = events.filter((e) => e.sessionUpdate === "tool_call_update");
      expect(tcus).toHaveLength(2);
      const parse = (idx: number) => {
        const e = defined(tcus[idx]);
        const block = e.content?.[0];
        const text =
          block?.type === "content" && block.content.type === "text"
            ? block.content.text
            : "";
        return JSON.parse(text) as Record<string, string | null>;
      };
      expect(parse(0)).toEqual({ A_TOKEN: "AAA", B_TOKEN: null, SHARED: "SSS" });
      expect(parse(1)).toEqual({ A_TOKEN: null, B_TOKEN: "BBB", SHARED: "SSS" });
    } finally {
      await agent.close();
    }
  });

  it("a Harness instance passed directly does NOT trigger secret resolution", async () => {
    let ran = false;
    const inst: Harness = {
      async run(rt) {
        ran = true;
        await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return { stopReason: "end_turn" as const };
      },
    };
    const agent = await runAgent(
      { name: "harness-instance", tools: {}, harness: inst },
      { secrets: new StaticSecretsStore({}) },
    );
    try {
      await agent.prompt("hi");
      expect(ran).toBe(true);
    } finally {
      await agent.close();
    }
  });

  it("onMissingSecret supplies a missing required secret and sees every miss", async () => {
    const seen: Array<{ name: string; requestedBy: string; required: boolean }> =
      [];
    const got = await runCapture("hook-required", {
      secrets: new StaticSecretsStore({}),
      onMissingSecret: async (req) => {
        seen.push({
          name: req.name,
          requestedBy: req.requestedBy,
          required: req.required,
        });
        return req.name === "CAPTURE_REQUIRED" ? "hooked" : null;
      },
    });
    expect(got).toEqual({ CAPTURE_REQUIRED: "hooked" });
    expect(seen.map((s) => s.name).sort()).toEqual([
      "CAPTURE_OPTIONAL",
      "CAPTURE_REQUIRED",
    ]);
    const required = seen.find((s) => s.name === "CAPTURE_REQUIRED");
    expect(required?.required).toBe(true);
    expect(required?.requestedBy).toBe("harness:capture");
    expect(seen.find((s) => s.name === "CAPTURE_OPTIONAL")?.required).toBe(false);
  });

  it("onMissingSecret returning null still throws SecretError for required", async () => {
    await expect(
      runAgent(
        { name: "hook-null", tools: {}, harness: { provider: "capture" } },
        {
          secrets: new StaticSecretsStore({}),
          onMissingSecret: async () => null,
        },
      ),
    ).rejects.toBeInstanceOf(SecretError);
  });

  it("onMissingSecret is bypassed when the chain already has a value", async () => {
    let calls = 0;
    const got = await runCapture("hook-bypass", {
      secrets: new StaticSecretsStore({
        CAPTURE_REQUIRED: "from-chain",
        CAPTURE_OPTIONAL: "opt-chain",
      }),
      onMissingSecret: async () => {
        calls += 1;
        return "should-not-be-used";
      },
    });
    expect(calls).toBe(0);
    expect(got).toEqual({
      CAPTURE_REQUIRED: "from-chain",
      CAPTURE_OPTIONAL: "opt-chain",
    });
  });

  it("phase-1 secret collection uses the package-name fallback (regression: 0.1.4 bug)", async () => {
    const { collectPhase1SecretNeeds } = await import("../src/sdk/run-agent.js");
    const { registerHarness: regH } = await import("../src/builtins/index.js");
    regH({
      name: "phase1-fallback-pkg",
      secrets: { required: ["PHASE1_FALLBACK_SECRET"] },
      create() {
        return { run: async () => ({ stopReason: "end_turn" as const }) };
      },
    });

    // Harness referenced via a 'companion' handle but registered under the
    // source basename: declarations surface only if the fallback engages.
    const needs = collectPhase1SecretNeeds(
      {
        providers: [],
        tools: [],
        sources: new Map(),
        harness: {
          factoryName: "companion",
          source: { path: "./phase1-fallback-pkg" },
          config: {},
        },
      },
      new Map(),
    );
    expect(needs.map((n) => n.name)).toContain("PHASE1_FALLBACK_SECRET");
  });
});
