import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { runAgent } from "../src/sdk/run-agent.js";
import type { AgentManifest } from "../src/types/manifest.js";

// The loom-invoke shim is always the compiled .js, spawned by tools as a
// fresh `node` process. If the build hasn't happened (fresh checkout,
// `npm test` before `npm run build`), this entire suite is skipped with a
// clear message rather than failing inside runAgent().
async function distExists(): Promise<boolean> {
  const shim = path.resolve("dist/cli/loom-invoke.js");
  try {
    await fs.access(shim);
    return true;
  } catch {
    return false;
  }
}

/** Materialize a tiny child agent on disk; subagents must be path-referenced. */
async function writeEchoChild(rootDir: string): Promise<string> {
  const childDir = path.join(rootDir, "child");
  await fs.mkdir(childDir, { recursive: true });
  await fs.writeFile(
    path.join(childDir, "agent.toml"),
    `[agent]
name = "child"
system_prompt = "c"
[tools]

[harness]
provider = "test"
echo = true
[session]
provider = "memory"
[sandbox]
filesystem = []
network = []
secrets = []
[skills]
`,
  );
  return path.join(childDir, "agent.toml");
}

/**
 * Phase E end-to-end: a process-backed tool that declares subagent
 * capability, gets `LOOM_INVOKE_SOCKET` + `LOOM_INVOKE_TOKEN` injected,
 * shells out via `loom-invoke <scope>`, and receives the subagent's
 * final message.
 *
 * This exercises:
 *   - LoomServer.embed() lifecycle in runAgent()
 *   - Per-skill token mint with the right scope set
 *   - The bin/loom-invoke shell wrapper provisioned on PATH
 *   - The loom-invoke shim reading env + speaking JSON-RPC to the broker
 *   - Token revocation after the tool process exits
 */
describe("broker end-to-end (loom-invoke shim)", () => {
  it("a process-backed tool spawns a subagent via loom-invoke", async () => {
    if (!(await distExists())) {
      console.warn(
        "[broker-e2e] skipping: dist/cli/loom-invoke.js not found. Run `npm run build` first.",
      );
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-broker-e2e-"));
    try {
      // 1. Child agent the tool will dispatch to (echoes the prompt).
      const childManifest = await writeEchoChild(root);

      // 2. The shell-shim that runs as the tool's invocation.command;
      //    has to live on disk because spawn() executes a real binary.
      const shimPath = path.join(root, "loom-delegate");
      await fs.writeFile(
        shimPath,
        `#!/bin/sh
read -r json
prompt=$(printf '%s' "$json" | sed -E 's/.*"prompt"[[:space:]]*:[[:space:]]*"([^"]*)".*/\\1/')
exec loom-invoke helper "$prompt"
`,
        { mode: 0o755 },
      );

      // 3. Parent agent is fully inline — agent + skill + tool definitions
      //    in one object literal. Only the shim binary and the child agent
      //    manifest stay on disk.
      const spec: AgentManifest = {
        name: "parent",
        systemPrompt: "p",
        tools: {},
        harness: {
          provider: "test",
          script: [
            [
              {
                call: {
                  tool: "delegate",
                  input: { prompt: "ping from outer" },
                },
              },
              { stop: "end_turn" },
            ],
          ],
        },
        sandbox: { filesystem: [], network: [], secrets: [] },
        skills: {
          delegator: {
            description: "shell-out delegation",
            requires: {
              delegate: {
                description: "Delegate the prompt to the helper subagent.",
                schema: {
                  type: "object",
                  required: ["prompt"],
                  properties: { prompt: { type: "string" } },
                },
                invocation: { command: shimPath },
                capabilities: {
                  filesystem: [],
                  network: [],
                  subagent: ["helper"],
                },
              },
            },
            subagents: { helper: childManifest },
          },
        },
      };

      // 4. Drive the parent: call delegate { prompt: "ping from outer" }.
      const parent = await runAgent(spec, {});
      try {
        await parent.prompt("go");
        const events = await parent.session.getEvents();
        const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
        expect(tu, "tool_call_update should be emitted").toBeTruthy();
        if (tu && tu.sessionUpdate === "tool_call_update") {
          expect(tu.status).toBe("completed");
          const text =
            tu.content?.[0]?.type === "content" &&
            tu.content[0].content.type === "text"
              ? tu.content[0].content.text
              : "";
          // The child runs with echo=true, so it returns "echo: <prompt>".
          // The shell-shim forwards stdin's prompt verbatim.
          expect(text).toContain("echo: ping from outer");
        }
      } finally {
        await parent.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("a tool without subagent capability gets no LOOM_INVOKE_* env vars", async () => {
    if (!(await distExists())) {
      console.warn(
        "[broker-e2e] skipping: dist/cli/loom-invoke.js not found. Run `npm run build` first.",
      );
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-broker-noenv-"));
    try {
      // Two shell shims on disk: a leak-checker and a delegate that the
      // broker is started for. Everything else is inline.
      const leakBin = path.join(root, "loom-leak-check");
      await fs.writeFile(
        leakBin,
        `#!/bin/sh
read -r _
if [ -n "$LOOM_INVOKE_TOKEN" ]; then
  echo "TOKEN_LEAKED"
else
  echo "ok"
fi
`,
        { mode: 0o755 },
      );
      const delegateBin = path.join(root, "loom-delegate");
      await fs.writeFile(delegateBin, "#!/bin/sh\nread -r _; echo ok\n", {
        mode: 0o755,
      });

      const childManifest = await writeEchoChild(root);

      const spec: AgentManifest = {
        name: "p",
        systemPrompt: "p",
        tools: {},
        harness: {
          provider: "test",
          script: [
            [{ call: { tool: "leak_check", input: {} } }, { stop: "end_turn" }],
          ],
        },
        sandbox: { filesystem: [], network: [], secrets: [] },
        skills: {
          s: {
            description: "x",
            requires: {
              leak_check: {
                description: "Detect broker env-var leakage.",
                schema: { type: "object" },
                invocation: { command: leakBin },
                capabilities: { filesystem: [], network: [] },
              },
              // A second tool that DOES declare subagent capability so the
              // broker is started. The leak_check tool is the negative
              // control: it must not see broker env vars.
              delegate2: {
                description: "trigger broker",
                schema: { type: "object" },
                invocation: { command: delegateBin },
                capabilities: {
                  filesystem: [],
                  network: [],
                  subagent: ["helper"],
                },
              },
            },
            subagents: { helper: childManifest },
          },
        },
      };

      const parent = await runAgent(spec, {});
      try {
        await parent.prompt("go");
        const events = await parent.session.getEvents();
        const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
        expect(tu).toBeTruthy();
        if (tu && tu.sessionUpdate === "tool_call_update") {
          const text =
            tu.content?.[0]?.type === "content" &&
            tu.content[0].content.type === "text"
              ? tu.content[0].content.text
              : "";
          expect(text).toContain("ok");
          expect(text).not.toContain("TOKEN_LEAKED");
        }
      } finally {
        await parent.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
