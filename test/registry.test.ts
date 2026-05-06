import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { LocalRegistry } from "../src/registry/registry.js";
import { resolveAgent } from "../src/manifest/resolver.js";
import { runAgent } from "../src/sdk/run-agent.js";
import type { AgentManifest } from "../src/types/manifest.js";

describe("LocalRegistry", () => {
  it("installs and looks up skills/tools by bare name", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "loom-home-"));
    try {
      const fixturesRoot = path.resolve("test/fixtures");
      const reg = new LocalRegistry({ root: home });

      const installedSkill = await reg.install(
        "skill",
        path.join(fixturesRoot, "skills/greeter"),
      );
      expect(installedSkill).toBe(path.join(home, "skills", "greeter"));
      expect(await reg.lookup("skill", "greeter")).toBe(installedSkill);

      const installedTool = await reg.install(
        "tool",
        path.join(fixturesRoot, "tools/uppercase"),
      );
      expect(installedTool).toBe(path.join(home, "tools", "uppercase"));
      expect(await reg.lookup("tool", "uppercase")).toBe(installedTool);
      expect(await reg.lookup("tool", "uppercase@1.0")).toBe(installedTool);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("resolves a bare-name skill at runAgent boot via LOOM_HOME", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "loom-home2-"));
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "loom-proj-"));
    const fixturesRoot = path.resolve("test/fixtures");
    const oldHome = process.env.LOOM_HOME;
    process.env.LOOM_HOME = home;
    try {
      const reg = new LocalRegistry({ root: home });
      // Install the greeter skill AND its two tools (since greeter requires
      // them by relative path and that won't work after copy).
      // Instead, install a self-contained skill with its tools alongside.
      const skillSrc = path.join(project, "src-skills", "greeter-bare");
      await fs.mkdir(skillSrc, { recursive: true });
      await fs.writeFile(
        path.join(skillSrc, "SKILL.md"),
        `---
name: greeter-bare
description: greet (bare name version)
requires:
  upper: ./tools/upper
---
body
`,
      );
      // Inline a private tool dir under the skill so the install copy is
      // self-contained.
      const toolSrc = path.join(skillSrc, "tools", "upper");
      await fs.mkdir(path.join(toolSrc, "bin"), { recursive: true });
      await fs.writeFile(
        path.join(toolSrc, "tool.toml"),
        `[tool]
name = "upper"
description = "Uppercase"
[tool.schema]
type = "object"
required = ["text"]
properties.text.type = "string"
[tool.invocation]
command = "test-upper"
[tool.secrets]
required = []
[tool.capabilities]
filesystem = []
network = []
`,
      );
      await fs.writeFile(
        path.join(toolSrc, "bin", "test-upper"),
        `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const i = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(String(i.text ?? "").toUpperCase());
`,
      );
      await fs.chmod(path.join(toolSrc, "bin", "test-upper"), 0o755);

      await reg.install("skill", skillSrc);
      void fixturesRoot;

      // Inline parent agent that references the registered skill by
      // bare name. The registry resolution still happens at runAgent
      // boot (which auto-mounts a LocalRegistry from LOOM_HOME).
      const spec: AgentManifest = {
        name: "bare-name-test",
        systemPrompt: "x",
        removeBuiltinTools: true,
        harness: {
          provider: "test",
          script: [
            [
              { call: { tool: "upper", input: { text: "hello" } } },
              { stop: "end_turn" },
            ],
          ],
        },
        sandbox: { filesystem: ["./"], network: [], secrets: [] },
        skills: { "greeter-bare": "greeter-bare" },
      };

      const agent = await runAgent(spec, {});
      try {
        await agent.prompt("go");
        const events = await agent.session.getEvents();
        const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
        expect(tu).toBeTruthy();
        if (tu && tu.sessionUpdate === "tool_call_update") {
          const text =
            tu.content?.[0]?.type === "content" &&
            tu.content[0].content.type === "text"
              ? tu.content[0].content.text
              : "";
          expect(text).toBe("HELLO");
        }
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
      // The resolver call would now find shadow under registry. The
      // parent agent itself is inline; only the skill is on disk
      // (because that's the registry's whole job).
      const spec: AgentManifest = {
        name: "x",
        systemPrompt: "x",
        removeBuiltinTools: true,
        harness: { provider: "test" },
        sandbox: { filesystem: ["./"], network: [], secrets: [] },
        skills: { shadow: "shadow" },
      };
      const r = await resolveAgent(spec, { registry: reg.lookup });
      expect(r.skills[0]?.manifest.name).toBe("shadow");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
