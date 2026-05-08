import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { runAgent } from "../src/sdk/run-agent.js";
import { ReadFileTool } from "../src/runtime/builtins/read_file.js";
import { assembleSystemPrompt } from "../src/runtime/system-prompt.js";
import {
  pathForSkill,
  renderVirtualSkillFile,
  virtualSkillPath,
} from "../src/runtime/skill-paths.js";
import type { SkillManifest } from "../src/types/manifest.js";
import type { Runtime, Harness } from "../src/types/interfaces.js";

/**
 * Skills as files: progressive disclosure via `read_file`.
 *
 * The catalog in the system prompt names each skill with its path
 * (real fs path on disk; `loom-skills:<name>/SKILL.md` for inline
 * skills). The model fetches the SKILL.md body with `read_file`. No
 * dedicated `read_skill` tool — `read_file` knows about the
 * synthetic scheme.
 */

describe("system-prompt catalog", () => {
  it("renders catalog only — name, description, path, tools — no body", () => {
    const text = assembleSystemPrompt({
      core: "core.",
      skills: [
        {
          name: "memory.recall",
          description: "Retrieve relevant prior conversations.",
          body: "BODY-SHOULD-NOT-APPEAR",
          toolNames: ["recall"],
          path: "loom-skills:memory.recall/SKILL.md",
        },
      ],
      tools: [],
      agentName: "x",
    });
    expect(text).toContain("# Available Skills");
    expect(text).toContain("memory.recall");
    expect(text).toContain("Retrieve relevant prior conversations.");
    expect(text).toContain("loom-skills:memory.recall/SKILL.md");
    expect(text).toContain("Tools: recall");
    expect(text).not.toContain("BODY-SHOULD-NOT-APPEAR");
    // Instructional preamble that tells the model to use read_file.
    expect(text).toContain("read_file");
  });
});

describe("ReadFileTool — virtual skills", () => {
  it("returns the in-memory body when the model reads a loom-skills: path", async () => {
    const tool = new ReadFileTool({
      paths: [],
      virtualSkills: {
        "loom-skills:greeter/SKILL.md":
          "---\nname: greeter\ndescription: Greet the user.\n---\n\nSay hi.\n",
      },
    });
    const ctx = makeStubCtx();
    const ok = await tool.execute(
      { path: "loom-skills:greeter/SKILL.md" },
      ctx,
    );
    expect(ok.isError).toBeUndefined();
    expect(ok.content).toContain("name: greeter");
    expect(ok.content).toContain("Say hi.");

    const miss = await tool.execute(
      { path: "loom-skills:unknown/SKILL.md" },
      ctx,
    );
    expect(miss.isError).toBe(true);
    expect(miss.content).toContain("not registered");
  });

  it("falls through to the normal fs path for non-virtual paths", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loom-readfile-"));
    const real = path.join(tmp, "hello.txt");
    await fs.writeFile(real, "from-disk", "utf8");
    try {
      const tool = new ReadFileTool({ paths: [tmp] });
      const out = await tool.execute({ path: real }, makeStubCtx());
      expect(out.isError).toBeUndefined();
      expect(out.content).toBe("from-disk");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("runAgent + skills wiring", () => {
  it("inline skill: read_file over the loom-skills: path returns the body", async () => {
    let captured = "";
    // Harness reads the skill via the runtime's tool table.
    const harness: Harness = {
      async run(rt: Runtime) {
        const result = await rt.executeTool({
          id: "1",
          name: "read_file",
          input: { path: "loom-skills:helper/SKILL.md" },
        });
        captured = result.content;
        await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return { stopReason: "end_turn" as const };
      },
    };

    const skillManifest: SkillManifest = {
      name: "helper",
      description: "A helper skill.",
      body: "Step 1: do thing. Step 2: do other thing.",
    };

    const agent = await runAgent({
      name: "with-inline-skill",
      systemPrompt: "x",
      tools: { read_file: { paths: [] } },
      harness,
      skills: { helper: skillManifest },
    });
    try {
      await agent.prompt("go");
      // The read_file tool returns the synthesised SKILL.md (frontmatter + body).
      expect(captured).toContain("name: helper");
      expect(captured).toContain("description:");
      expect(captured).toContain("Step 1: do thing.");
    } finally {
      await agent.close();
    }
  });

  it("the listed skill path matches what runtime.systemPrompt() emits", async () => {
    let prompt = "";
    const harness: Harness = {
      async run(rt: Runtime) {
        prompt = rt.systemPrompt();
        await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return { stopReason: "end_turn" as const };
      },
    };
    const agent = await runAgent({
      name: "with-inline-skill",
      systemPrompt: "x",
      tools: { read_file: { paths: [] } },
      harness,
      skills: {
        helper: {
          name: "helper",
          description: "A helper skill.",
          body: "...",
        },
      },
    });
    try {
      await agent.prompt("go");
      expect(prompt).toContain("loom-skills:helper/SKILL.md");
      // Body must NOT be inlined anymore — Tier-2 disclosure only.
      expect(prompt).not.toContain("...".repeat(1));
    } finally {
      await agent.close();
    }
  });
});

describe("skill-paths helpers", () => {
  it("pathForSkill uses skillDir/SKILL.md on disk and the virtual scheme inline", () => {
    const onDisk: SkillManifest = {
      name: "x",
      description: "d",
      skillDir: "/abs/path/to/x",
    };
    expect(pathForSkill(onDisk)).toBe("/abs/path/to/x/SKILL.md");

    const inline: SkillManifest = { name: "y", description: "d" };
    expect(pathForSkill(inline)).toBe("loom-skills:y/SKILL.md");
  });

  it("renderVirtualSkillFile re-emits a SKILL.md-shaped body", () => {
    const out = renderVirtualSkillFile({
      name: "demo",
      description: "Use this for foo.",
      body: "Steps: 1, 2, 3.",
    });
    expect(out).toContain("---");
    expect(out).toContain("name: demo");
    expect(out).toContain('description: "Use this for foo."');
    expect(out).toContain("Steps: 1, 2, 3.");
  });

  it("virtualSkillPath produces the canonical scheme", () => {
    expect(virtualSkillPath("memory.recall")).toBe(
      "loom-skills:memory.recall/SKILL.md",
    );
  });
});

function makeStubCtx() {
  return {
    secrets: {},
    abortSignal: new AbortController().signal,
    requestPermission: async () => ({ decision: "deny" as const }),
    searchSkills: async () => [],
    agent: {
      harness: {
        run: async () => ({ stopReason: "end_turn" as const }),
      },
      session: {
        append: async () => {},
        getEvents: async () => [],
        count: async () => 0,
      },
      systemPromptCore: "",
      agentName: "stub",
    },
  };
}
