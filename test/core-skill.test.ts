import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { runAgent } from "../src/sdk/run-agent.js";
import { resolveAgent } from "../src/manifest/resolver.js";
import { auditAgent } from "../src/audit/audit.js";
import { memorySessionFactory } from "../src/extensions/session/memory.js";
import { testHarnessFactory } from "../src/extensions/harness/test.js";
import { CapabilityError } from "../src/errors.js";

/**
 * Build a minimal agent.toml in a tmp dir with a permissive enough
 * [sandbox] for the auto-loaded core skill (filesystem ["./"]).
 */
async function buildAgentDir(opts: {
  rootDir: string;
  systemPrompt?: string;
  removeBuiltinTools?: boolean;
  filesystem?: string[];
}): Promise<string> {
  const dir = path.join(opts.rootDir, "agent");
  await fs.mkdir(dir, { recursive: true });
  const fs_ =
    opts.filesystem !== undefined
      ? `[${opts.filesystem.map((s) => `"${s}"`).join(", ")}]`
      : `["./"]`;
  const sp = opts.systemPrompt ?? "be brief";
  const flag = opts.removeBuiltinTools ? "remove_builtin_tools = true\n" : "";
  await fs.writeFile(
    path.join(dir, "agent.toml"),
    `[agent]
name = "demo"
system_prompt = "${sp.replace(/"/g, '\\"')}"
${flag}
[harness]
provider = "test"

[session]
provider = "memory"

[sandbox]
filesystem = ${fs_}
network = []
secrets = []

[skills]
`,
  );
  return path.join(dir, "agent.toml");
}

describe("core builtin skill — auto-load + inline rendering", () => {
  it("auto-loads bash / find / read_file / write_file with default settings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "glass-core-default-"));
    try {
      const m = await buildAgentDir({ rootDir: root });
      const r = await resolveAgent(m);
      expect(r.skills.map((s) => s.manifest.name)).toContain("core");
      const coreSkill = r.skills.find((s) => s.manifest.name === "core");
      expect(coreSkill?.manifest.inlineInSystemPrompt).toBe(true);
      expect(r.tools.map((t) => t.manifest.tool.name).sort()).toEqual([
        "bash",
        "find",
        "read_file",
        "write_file",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("remove_builtin_tools = true suppresses the auto-load entirely", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "glass-core-off-"));
    try {
      const m = await buildAgentDir({ rootDir: root, removeBuiltinTools: true });
      const r = await resolveAgent(m);
      expect(r.skills).toHaveLength(0);
      expect(r.tools).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("the system prompt inlines the core skill body and omits it from # Available Skills", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "glass-core-prompt-"));
    try {
      const m = await buildAgentDir({
        rootDir: root,
        systemPrompt: "You are a focused engineer.",
      });
      const agent = await runAgent(m, {
        sessionOverride: memorySessionFactory,
        harnessOverride: {
          factory: testHarnessFactory,
          config: {
            // Capture the system prompt the harness sees from the runtime.
            script: async (rt) => {
              capturedPrompt = rt.systemPrompt();
              return [{ stop: "end_turn" }];
            },
          },
        },
      });
      let capturedPrompt = "";
      try {
        await agent.prompt("hi");
      } finally {
        await agent.close();
      }
      // (Re-resolve capturedPrompt via a fresh agent since the closure above
      // only fires inside the harness — we can also just inspect runtime
      // state directly.)
      const agent2 = await runAgent(m, {
        sessionOverride: memorySessionFactory,
        harnessOverride: {
          factory: testHarnessFactory,
          config: {
            script: async (rt) => {
              capturedPrompt = rt.systemPrompt();
              return [{ stop: "end_turn" }];
            },
          },
        },
      });
      try {
        await agent2.prompt("hi");
      } finally {
        await agent2.close();
      }
      expect(capturedPrompt).toContain("You are a focused engineer.");
      // Core skill body inlined, no '## core' heading, no '# Available Skills'
      // entry naming it.
      expect(capturedPrompt).toContain("Core file & shell tools");
      expect(capturedPrompt).not.toMatch(/##\s+core\b/);
      expect(capturedPrompt).not.toMatch(/# Available Skills[\s\S]*##\s+core\b/);
      // Tools still appear in the Tool Reference section.
      expect(capturedPrompt).toContain("# Tool Reference");
      expect(capturedPrompt).toMatch(/`bash`/);
      expect(capturedPrompt).toMatch(/`read_file`/);
      expect(capturedPrompt).toMatch(/`write_file`/);
      expect(capturedPrompt).toMatch(/`find`/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolver throws a capability-error with a hint pointing at remove_builtin_tools when [sandbox] doesn't fit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "glass-core-cap-"));
    try {
      const m = await buildAgentDir({ rootDir: root, filesystem: [] });
      let err: unknown;
      try {
        await resolveAgent(m);
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      // The wrapped error keeps the CapabilityError's name on the inner
      // throw and is re-thrown as a plain Error wrapped with a hint.
      const msg = (err as Error).message;
      expect(msg).toMatch(/exceed.*ceiling|core.*builtin/i);
      expect(msg).toContain("remove_builtin_tools = true");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("end-to-end: agent uses write_file then read_file via the auto-loaded core", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "glass-core-e2e-"));
    try {
      const m = await buildAgentDir({ rootDir: root });
      // The agent will write a file, then read it back. Both via core tools.
      const target = path.join(root, "agent", "hello.txt");
      const agent = await runAgent(m, {
        sessionOverride: memorySessionFactory,
        harnessOverride: {
          factory: testHarnessFactory,
          config: {
            script: [
              [
                {
                  call: {
                    tool: "write_file",
                    input: { path: target, content: "from-core-skill" },
                  },
                },
                {
                  call: { tool: "read_file", input: { path: target } },
                  surface: true,
                },
                { stop: "end_turn" },
              ],
            ],
          },
        },
      });
      try {
        await agent.prompt("go");
        const events = await agent.session.getEvents();
        const tcus = events.filter((e) => e.sessionUpdate === "tool_call_update");
        expect(tcus).toHaveLength(2);
        // Read result must show the content.
        const readResult = tcus[1];
        if (readResult && readResult.sessionUpdate === "tool_call_update") {
          expect(readResult.status).toBe("completed");
          const text =
            readResult.content?.[0]?.type === "content" &&
            readResult.content[0].content.type === "text"
              ? readResult.content[0].content.text
              : "";
          expect(text).toBe("from-core-skill");
        }
      } finally {
        await agent.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("core skill participates in audit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "glass-core-audit-"));
    try {
      const m = await buildAgentDir({ rootDir: root });
      const tree = await auditAgent(m);
      const names = tree.tools.map((t) => t.name).sort();
      expect(names).toEqual(["bash", "find", "read_file", "write_file"]);
      expect(tree.tools.every((t) => t.introducedBy === "core")).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// silence the unused-var for the helper
void CapabilityError;
