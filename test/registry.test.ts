import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { LocalRegistry } from "../src/registry/registry.js";
import { runAgent } from "../src/sdk/run-agent.js";
import type { AgentManifest } from "../src/types/manifest.js";

describe("LocalRegistry", () => {
  it("resolves a bare-name skill at runAgent boot via LOOM_HOME", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "loom-home2-"));
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "loom-proj-"));
    const oldHome = process.env.LOOM_HOME;
    process.env.LOOM_HOME = home;
    try {
      const reg = new LocalRegistry({ root: home });
      // Install a self-contained skill into the registry. Its `requires`
      // points at a builtin (`bash`) — the registry's job is only to
      // surface the SKILL.md by bare name; the tool itself comes from
      // the native provider.
      const skillSrc = path.join(project, "src-skills", "registered-skill");
      await fs.mkdir(skillSrc, { recursive: true });
      await fs.writeFile(
        path.join(skillSrc, "SKILL.md"),
        `---
name: registered-skill
description: a skill addressable by bare name
requires:
  bash: builtin
---
body
`,
      );
      await reg.install("skill", skillSrc);

      // Inline parent agent that references the registered skill by
      // bare name. The registry resolution still happens at runAgent
      // boot (which auto-mounts a LocalRegistry from LOOM_HOME).
      const spec: AgentManifest = {
        name: "bare-name-test",
        systemPrompt: "x",
        tools: {},
        harness: {
          provider: "test",
          script: [[{ stop: "end_turn" }]],
        },
        skills: { "registered-skill": "registered-skill" },
      };

      const agent = await runAgent(spec, {});
      try {
        await agent.prompt("go");
        const skill = agent.agentState.skills.find(
          (s) => s.name === "registered-skill",
        );
        expect(skill).toBeTruthy();
        expect(agent.agentState.toolTable.has("bash")).toBe(true);
      } finally {
        await agent.close();
      }
    } finally {
      if (oldHome === undefined) delete process.env.LOOM_HOME;
      else process.env.LOOM_HOME = oldHome;
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(project, { recursive: true, force: true });
    }
  });

  it("registry is consulted before builtin fallback", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "loom-home3-"));
    const oldHome = process.env.LOOM_HOME;
    process.env.LOOM_HOME = home;
    try {
      const reg = new LocalRegistry({ root: home });
      // Install a skill at the registry called 'shadow' that wraps a builtin.
      const src = path.join(home, ".src", "shadow");
      await fs.mkdir(src, { recursive: true });
      await fs.writeFile(
        path.join(src, "SKILL.md"),
        `---
name: shadow
description: shadow skill
requires:
  bash: builtin
---
shadowed`,
      );
      await reg.install("skill", src);
      expect(await reg.lookup("skill", "shadow")).toMatch(/skills\/shadow$/);
      // The runAgent call resolves the bare-name skill via the registry
      // mounted from LOOM_HOME. The parent agent itself is inline; only
      // the skill is on disk (because that's the registry's whole job).
      const spec: AgentManifest = {
        name: "x",
        systemPrompt: "x",
        tools: {},
        harness: { provider: "test" },
        skills: { shadow: "shadow" },
      };
      const agent = await runAgent(spec, {});
      try {
        const skill = agent.agentState.skills.find((s) => s.name === "shadow");
        expect(skill).toBeTruthy();
      } finally {
        await agent.close();
      }
    } finally {
      if (oldHome === undefined) delete process.env.LOOM_HOME;
      else process.env.LOOM_HOME = oldHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
