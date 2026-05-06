import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { runAgent } from "../src/sdk/run-agent.js";
import { auditAgent } from "../src/audit/audit.js";
import type { AgentManifest } from "../src/types/manifest.js";

/**
 * Materialize a small helper child agent on disk and return its absolute
 * `agent.toml` path. The child runs the test harness in echo mode.
 *
 * The child has to live on disk because subagent references are paths /
 * registry names / acp:// URLs — runAgent loads them as separate agents
 * via `runAgent(<path>)`. Inline-only at the parent level is fine; the
 * subagent dependency points outward.
 */
async function writeEchoChild(rootDir: string): Promise<string> {
  const childDir = path.join(rootDir, "child");
  await fs.mkdir(childDir, { recursive: true });
  await fs.writeFile(
    path.join(childDir, "agent.toml"),
    `[agent]
name = "child"
system_prompt = "child"
remove_builtin_tools = true

[harness]
provider = "test"
echo = true
[session]
provider = "memory"
`,
  );
  return path.join(childDir, "agent.toml");
}

describe("subagents", () => {
  it("parent calls helper via spawn_subagent end-to-end", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-sub-"));
    try {
      const childManifest = await writeEchoChild(root);
      const spec: AgentManifest = {
        name: "parent",
        systemPrompt: "parent",
        removeBuiltinTools: true,
        harness: {
          provider: "test",
          script: [
            [
              {
                call: {
                  tool: "spawn_subagent",
                  input: { scope: "helper", prompt: "hello child" },
                },
              },
              { stop: "end_turn" },
            ],
          ],
        },
        skills: {
          composer: {
            description: "Compose by delegating",
            requires: { spawn_subagent: "builtin" },
            subagents: { helper: childManifest },
          },
        },
      };
      const agent = await runAgent(spec, {});
      try {
        await agent.prompt("delegate");
        const events = await agent.session.getEvents();
        const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
        expect(tu).toBeTruthy();
        if (tu && tu.sessionUpdate === "tool_call_update") {
          expect(tu.status).toBe("completed");
          const text =
            tu.content?.[0]?.type === "content" &&
            tu.content[0].content.type === "text"
              ? tu.content[0].content.text
              : "";
          expect(text).toContain("echo: hello child");
        }
      } finally {
        await agent.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("auditAgent recursively traverses subagents", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-sub-audit-"));
    try {
      const childManifest = await writeEchoChild(root);
      const spec: AgentManifest = {
        name: "parent",
        systemPrompt: "p",
        removeBuiltinTools: true,
        harness: { provider: "test" },
        skills: {
          composer: {
            description: "x",
            subagents: { helper: childManifest },
          },
        },
      };
      const tree = await auditAgent(spec);
      expect(tree.subagents).toHaveLength(1);
      expect(tree.subagents[0]?.name).toBe("helper");
      expect(tree.subagents[0]?.tree?.name).toBe("child");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("auditAgent surfaces acp:// subagents as remote (no recursion)", async () => {
    const spec: AgentManifest = {
      name: "p",
      systemPrompt: "p",
      removeBuiltinTools: true,
      harness: { provider: "test" },
      skills: {
        remote: {
          description: "remote subagent",
          subagents: { helper: "acp://example.com:9000/helper" },
        },
      },
    };
    const tree = await auditAgent(spec);
    expect(tree.subagents).toHaveLength(1);
    expect(tree.subagents[0]?.kind).toBe("acp");
    expect(tree.subagents[0]?.note).toMatch(/acp:\/\/example.com/);
  });

  it("unknown subagent scope at runtime raises a tool error", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-sub-unknown-"));
    try {
      const childManifest = await writeEchoChild(root);
      const spec: AgentManifest = {
        name: "p",
        systemPrompt: "p",
        removeBuiltinTools: true,
        harness: {
          provider: "test",
          script: [
            [
              {
                call: {
                  tool: "spawn_subagent",
                  input: { scope: "ghost", prompt: "x" },
                },
              },
              { stop: "end_turn" },
            ],
          ],
        },
        skills: {
          s: {
            description: "x",
            requires: { spawn_subagent: "builtin" },
            subagents: { helper: childManifest },
          },
        },
      };
      const agent = await runAgent(spec, {});
      try {
        await agent.prompt("go");
        const events = await agent.session.getEvents();
        const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
        expect(tu).toBeTruthy();
        if (tu && tu.sessionUpdate === "tool_call_update") {
          expect(tu.status).toBe("failed");
          const text =
            tu.content?.[0]?.type === "content" &&
            tu.content[0].content.type === "text"
              ? tu.content[0].content.text
              : "";
          expect(text).toMatch(/Unknown subagent scope 'ghost'/);
        }
      } finally {
        await agent.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
