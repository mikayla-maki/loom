import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { runAgent, StaticSecretsStore } from "../src/sdk/run-agent.js";
import { SecretError } from "../src/errors.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type {
  ExtensionContext,
  Harness,
  HarnessFactory,
  Runtime,
} from "../src/types/interfaces.js";
import type { StopReason } from "../src/types/acp.js";
import { registerHarness } from "../src/extensions/index.js";

/**
 * The secrets pipeline contract:
 *   1. Factories declare what they need; runtime resolves the closure
 *      from a SecretsStore chain (caller-supplied → env → file).
 *   2. A required miss fails the boot with a message naming who asked.
 *   3. Each component receives ONLY the secrets it declared at create
 *      time. Tools see their per-tool subset at every execute() call.
 *   4. Factory implementations do NOT read `process.env`.
 */

// A captured-secrets harness factory used by these tests. Records what
// the runtime hands it at create() so we can assert the slice.
const capturedByHarness = new Map<string, Record<string, string>>();
const captureFactory: HarnessFactory = {
  name: "capture",
  secrets: { required: ["CAPTURE_REQUIRED"], optional: ["CAPTURE_OPTIONAL"] },
  create(
    _config: Record<string, unknown>,
    _ctx: ExtensionContext,
    secrets: Record<string, string>,
  ): Harness {
    const id = String(_ctx.agentName);
    capturedByHarness.set(id, { ...secrets });
    return {
      async run(rt: Runtime): Promise<StopReason> {
        await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return "end_turn";
      },
    };
  },
};
registerHarness(captureFactory);

describe("secrets pipeline", () => {
  it("a factory receives only its declared secrets, never the full bag", async () => {
    capturedByHarness.clear();
    const agent = await runAgent(
      {
        name: "factory-slice",
        removeBuiltinTools: true,
        harness: { provider: "capture" },
      },
      {
        secrets: new StaticSecretsStore({
          CAPTURE_REQUIRED: "rv",
          CAPTURE_OPTIONAL: "ov",
          UNRELATED: "should-not-appear",
        }),
      },
    );
    try {
      const got = capturedByHarness.get("factory-slice");
      expect(got).toEqual({
        CAPTURE_REQUIRED: "rv",
        CAPTURE_OPTIONAL: "ov",
      });
      expect(got).not.toHaveProperty("UNRELATED");
    } finally {
      await agent.close();
    }
  });

  it("missing required secret throws SecretError naming the requester", async () => {
    await expect(
      runAgent(
        {
          name: "missing-required",
          removeBuiltinTools: true,
          harness: { provider: "capture" },
        },
        { secrets: new StaticSecretsStore({}) }, // no CAPTURE_REQUIRED
      ),
    ).rejects.toThrow(/CAPTURE_REQUIRED.*harness:capture/s);
  });

  it("optional secret missing is silently absent (not in the slice)", async () => {
    capturedByHarness.clear();
    const agent = await runAgent(
      {
        name: "optional-missing",
        removeBuiltinTools: true,
        harness: { provider: "capture" },
      },
      {
        secrets: new StaticSecretsStore({ CAPTURE_REQUIRED: "rv" }),
      },
    );
    try {
      const got = capturedByHarness.get("optional-missing");
      expect(got).toEqual({ CAPTURE_REQUIRED: "rv" });
      expect(got).not.toHaveProperty("CAPTURE_OPTIONAL");
    } finally {
      await agent.close();
    }
  });

  it("a tool only sees its own declared secrets at execute time", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-secret-iso-"));
    try {
      // Two tool scripts, each printing its env for a fixed set of names.
      const printScript = (binPath: string) =>
        fs.writeFile(
          binPath,
          `#!/usr/bin/env node
const want = ['A_TOKEN','B_TOKEN','SHARED'];
const out = {};
for (const k of want) out[k] = process.env[k] ?? null;
process.stdout.write(JSON.stringify(out));
`,
          { mode: 0o755 },
        );
      const aPath = path.join(root, "tool-a");
      const bPath = path.join(root, "tool-b");
      await printScript(aPath);
      await printScript(bPath);

      const agent = await runAgent(
        {
          name: "secret-iso",
          removeBuiltinTools: true,
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
          skills: {
            s: {
              description: "two tools, different secrets",
              requires: {
                tool_a: {
                  description: "a",
                  schema: { type: "object" },
                  invocation: { command: aPath },
                  secrets: { required: ["A_TOKEN", "SHARED"] },
                },
                tool_b: {
                  description: "b",
                  schema: { type: "object" },
                  invocation: { command: bPath },
                  secrets: { required: ["B_TOKEN", "SHARED"] },
                },
              },
            },
          },
        },
        {
          secrets: new StaticSecretsStore({
            A_TOKEN: "AAA",
            B_TOKEN: "BBB",
            SHARED: "SSS",
          }),
        },
      );
      try {
        await agent.prompt("go");
        const events = await agent.session.getEvents();
        const tcus = events.filter(
          (e) => e.sessionUpdate === "tool_call_update",
        );
        expect(tcus).toHaveLength(2);
        const parse = (idx: number) => {
          const e = tcus[idx];
          if (!e || e.sessionUpdate !== "tool_call_update") return null;
          const text =
            e.content?.[0]?.type === "content" &&
            e.content[0].content.type === "text"
              ? e.content[0].content.text
              : "";
          return JSON.parse(text) as Record<string, string | null>;
        };
        const a = parse(0);
        const b = parse(1);
        // tool_a sees A_TOKEN + SHARED, NOT B_TOKEN.
        expect(a).toEqual({ A_TOKEN: "AAA", B_TOKEN: null, SHARED: "SSS" });
        // tool_b sees B_TOKEN + SHARED, NOT A_TOKEN.
        expect(b).toEqual({ A_TOKEN: null, B_TOKEN: "BBB", SHARED: "SSS" });
      } finally {
        await agent.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("a Harness instance passed directly does NOT trigger secret resolution", async () => {
    // Custom Harness instance bypasses the factory layer entirely. The
    // runtime should not attempt to look up factory secrets for it.
    let ran = false;
    const inst: Harness = {
      async run(rt) {
        ran = true;
        await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return "end_turn";
      },
    };
    const agent = await runAgent(
      { name: "harness-instance", removeBuiltinTools: true, harness: inst },
      {
        // Empty store: the test verifies no secrets are demanded.
        secrets: new StaticSecretsStore({}),
      },
    );
    try {
      await agent.prompt("hi");
      expect(ran).toBe(true);
    } finally {
      await agent.close();
    }
  });

  it("onMissingSecret hook supplies a missing required secret", async () => {
    capturedByHarness.clear();
    const seen: Array<{
      name: string;
      requestedBy: string;
      required: boolean;
    }> = [];
    const agent = await runAgent(
      {
        name: "hook-required",
        removeBuiltinTools: true,
        harness: { provider: "capture" },
      },
      {
        secrets: new StaticSecretsStore({}), // chain has nothing
        onMissingSecret: async (req) => {
          seen.push({
            name: req.name,
            requestedBy: req.requestedBy,
            required: req.required,
          });
          if (req.name === "CAPTURE_REQUIRED") return "hooked";
          return null; // optional miss → skip
        },
      },
    );
    try {
      const got = capturedByHarness.get("hook-required");
      expect(got).toEqual({ CAPTURE_REQUIRED: "hooked" });
      // Both required and optional missed; hook saw both.
      expect(seen.map((s) => s.name).sort()).toEqual([
        "CAPTURE_OPTIONAL",
        "CAPTURE_REQUIRED",
      ]);
      const req = seen.find((s) => s.name === "CAPTURE_REQUIRED");
      expect(req?.required).toBe(true);
      expect(req?.requestedBy).toBe("harness:capture");
      const opt = seen.find((s) => s.name === "CAPTURE_OPTIONAL");
      expect(opt?.required).toBe(false);
    } finally {
      await agent.close();
    }
  });

  it("onMissingSecret returning null still throws SecretError for required", async () => {
    await expect(
      runAgent(
        {
          name: "hook-null",
          removeBuiltinTools: true,
          harness: { provider: "capture" },
        },
        {
          secrets: new StaticSecretsStore({}),
          onMissingSecret: async () => null,
        },
      ),
    ).rejects.toBeInstanceOf(SecretError);
  });

  it("onMissingSecret is bypassed when the chain already has a value", async () => {
    capturedByHarness.clear();
    let calls = 0;
    const agent = await runAgent(
      {
        name: "hook-bypass",
        removeBuiltinTools: true,
        harness: { provider: "capture" },
      },
      {
        secrets: new StaticSecretsStore({
          CAPTURE_REQUIRED: "from-chain",
          CAPTURE_OPTIONAL: "opt-chain",
        }),
        onMissingSecret: async () => {
          calls += 1;
          return "should-not-be-used";
        },
      },
    );
    try {
      expect(calls).toBe(0);
      expect(capturedByHarness.get("hook-bypass")).toEqual({
        CAPTURE_REQUIRED: "from-chain",
        CAPTURE_OPTIONAL: "opt-chain",
      });
    } finally {
      await agent.close();
    }
  });
});
