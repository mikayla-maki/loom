import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { runAgent } from "../src/sdk/run-agent.js";
import { resolveAgent } from "../src/manifest/resolver.js";
import { auditAgent } from "../src/audit/audit.js";
import { CapabilityError } from "../src/errors.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type { Runtime } from "../src/types/interfaces.js";
import type { TurnStep, TurnScript } from "../src/extensions/harness/test.js";

/**
 * Build a minimal inline agent spec. Defaults to a permissive enough
 * `[sandbox]` for the auto-loaded core skill (filesystem ["./"]). Pass
 * `filesystem` explicitly to constrain it (e.g. for the capability-error
 * test). Omit the `sandbox` field entirely for "no constraints" by
 * passing `permissive: true`.
 */
function buildAgentSpec(opts: {
  systemPrompt?: string;
  removeBuiltinTools?: boolean;
  filesystem?: string[];
  harnessScript?:
    | TurnScript[]
    | ((rt: Runtime, turnIndex: number) => Promise<TurnStep[]> | TurnStep[]);
}): AgentManifest {
  const sandbox =
    opts.filesystem !== undefined
      ? { filesystem: opts.filesystem, network: [], secrets: [] }
      : { filesystem: ["./"], network: [], secrets: [] };
  return {
    name: "demo",
    systemPrompt: opts.systemPrompt ?? "be brief",
    ...(opts.removeBuiltinTools ? { removeBuiltinTools: true } : {}),
    harness: {
      provider: "test",
      ...(opts.harnessScript ? { script: opts.harnessScript } : {}),
    },
    sandbox,
    skills: {},
  };
}

describe("core builtin skill — auto-load + inline rendering", () => {
  it("auto-loads bash / find / read_file / write_file with default settings", async () => {
    const r = await resolveAgent(buildAgentSpec({}));
    expect(r.skills.map((s) => s.manifest.name)).toContain("core");
    const coreSkill = r.skills.find((s) => s.manifest.name === "core");
    expect(coreSkill?.manifest.inlineInSystemPrompt).toBe(true);
    expect(r.tools.map((t) => t.manifest.name).sort()).toEqual([
      "bash",
      "find",
      "read_file",
      "write_file",
    ]);
  });

  it("remove_builtin_tools = true suppresses the auto-load entirely", async () => {
    const r = await resolveAgent(buildAgentSpec({ removeBuiltinTools: true }));
    expect(r.skills).toHaveLength(0);
    expect(r.tools).toHaveLength(0);
  });

  it("the system prompt inlines the core skill body and omits it from # Available Skills", async () => {
    let capturedPrompt = "";
    const spec = buildAgentSpec({
      systemPrompt: "You are a focused engineer.",
      harnessScript: async (rt: Runtime) => {
        capturedPrompt = rt.systemPrompt();
        return [{ stop: "end_turn" }];
      },
    });
    const agent = await runAgent(spec, {});
    try {
      await agent.prompt("hi");
    } finally {
      await agent.close();
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
  });

  it("resolver throws a capability-error with a hint pointing at remove_builtin_tools when [sandbox] doesn't fit", async () => {
    const spec = buildAgentSpec({ filesystem: [] });
    let err: unknown;
    try {
      await resolveAgent(spec);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    // The wrapped error keeps the CapabilityError's name on the inner
    // throw and is re-thrown as a plain Error wrapped with a hint.
    const msg = (err as Error).message;
    expect(msg).toMatch(/exceed.*ceiling|core.*builtin/i);
    expect(msg).toContain("remove_builtin_tools = true");
  });

  it("end-to-end: agent uses write_file then read_file via the auto-loaded core", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loom-core-e2e-"));
    try {
      // The agent will write a file, then read it back — the target
      // file is real on-disk user data, but the agent itself is inline.
      const target = path.join(root, "hello.txt");
      const agent = await runAgent(
        buildAgentSpec({
          harnessScript: [
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
        }),
        {},
      );
      try {
        await agent.prompt("go");
        const events = await agent.session.getEvents();
        const tcus = events.filter(
          (e) => e.sessionUpdate === "tool_call_update",
        );
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
    const tree = await auditAgent(buildAgentSpec({}));
    const names = tree.tools.map((t) => t.name).sort();
    expect(names).toEqual(["bash", "find", "read_file", "write_file"]);
    expect(tree.tools.every((t) => t.introducedBy === "core")).toBe(true);
  });
});

// silence the unused-var for the helper
void CapabilityError;
