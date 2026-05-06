import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { runAgent } from "../src/sdk/run-agent.js";
import { LocalRegistry } from "../src/registry/registry.js";
import {
  allowAllPermissionHandler,
  denyAllPermissionHandler,
} from "../src/types/permissions.js";
import type {
  PermissionHandler,
  PermissionRequest,
  PermissionResult,
} from "../src/types/permissions.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type { TurnScript } from "../src/extensions/harness/test.js";

const FIXTURES = path.resolve("test/fixtures");

/**
 * Build a tmp $LOOM_HOME with two installable skills:
 *   - safe-skill        (no extra capabilities)
 *   - net-skill         (network = ['extra.example.com'])
 */
async function buildHomeWithSkills(): Promise<{
  home: string;
  cleanup: () => Promise<void>;
}> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "loom-disco-"));
  const reg = new LocalRegistry({ root: home });

  // safe-skill: bring a pure-stdout tool with no caps.
  const safeSrc = path.join(home, "_src", "safe");
  await fs.mkdir(safeSrc, { recursive: true });
  await fs.writeFile(
    path.join(safeSrc, "SKILL.md"),
    `---
name: safe-skill
description: Safe skill — no extra capabilities.
requires:
  reverse: ./tools/reverse
---
body
`,
  );
  const reverseDir = path.join(safeSrc, "tools", "reverse");
  await fs.mkdir(path.join(reverseDir, "bin"), { recursive: true });
  await fs.writeFile(
    path.join(reverseDir, "tool.toml"),
    `[tool]
name = "reverse"
description = "Reverse a string"
[tool.schema]
type = "object"
required = ["text"]
properties.text.type = "string"
[tool.invocation]
command = "test-reverse"
[tool.secrets]
required = []
[tool.capabilities]
filesystem = []
network = []
`,
  );
  await fs.writeFile(
    path.join(reverseDir, "bin", "test-reverse"),
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const i = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(String(i.text ?? "").split("").reverse().join(""));
`,
  );
  await fs.chmod(path.join(reverseDir, "bin", "test-reverse"), 0o755);
  await reg.install("skill", safeSrc);

  // net-skill: declares network = ['extra.example.com'] (outside default ceiling).
  const netSrc = path.join(home, "_src", "net");
  await fs.mkdir(netSrc, { recursive: true });
  await fs.writeFile(
    path.join(netSrc, "SKILL.md"),
    `---
name: net-skill
description: Skill that needs additional network capability.
requires:
  pingish: ./tools/pingish
---
body
`,
  );
  const pingDir = path.join(netSrc, "tools", "pingish");
  await fs.mkdir(path.join(pingDir, "bin"), { recursive: true });
  await fs.writeFile(
    path.join(pingDir, "tool.toml"),
    `[tool]
name = "pingish"
description = "Pretends to ping"
[tool.schema]
type = "object"
required = ["host"]
properties.host.type = "string"
[tool.invocation]
command = "test-pingish"
[tool.secrets]
required = []
[tool.capabilities]
filesystem = []
network = ["extra.example.com"]
`,
  );
  await fs.writeFile(
    path.join(pingDir, "bin", "test-pingish"),
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const i = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write("ping " + i.host);
`,
  );
  await fs.chmod(path.join(pingDir, "bin", "test-pingish"), 0o755);
  await reg.install("skill", netSrc);

  return {
    home,
    cleanup: async () => {
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}

/**
 * Build an inline agent spec that brings in `search_skills` and
 * `add_skill` as builtins (privileged in-process tools), within an
 * arbitrary `[sandbox]` ceiling. The "discovery" skill is just a
 * couple of builtin tool requires — declared inline.
 */
function buildAgent(
  opts: {
    ceilingNetwork?: string[];
    script?: TurnScript[];
  } = {},
): AgentManifest {
  return {
    name: "discoverer",
    systemPrompt: "x",
    removeBuiltinTools: true,
    harness: {
      provider: "test",
      ...(opts.script ? { script: opts.script } : {}),
    },
    sandbox: {
      filesystem: ["./"],
      network: opts.ceilingNetwork ?? [],
      secrets: [],
    },
    skills: {
      discovery: {
        description: "Skill discovery & dynamic addition.",
        body: "Use search_skills to list candidates; use add_skill to load one.\n",
        requires: {
          search_skills: "builtin",
          add_skill: "builtin",
        },
      },
    },
  };
}

describe("search_skills + add_skill — discovery + dynamic addition", () => {
  it("search_skills lists registry-installed skills", async () => {
    const { home, cleanup } = await buildHomeWithSkills();
    const old = process.env.LOOM_HOME;
    process.env.LOOM_HOME = home;
    try {
      const agent = await runAgent(
        buildAgent({
          script: [
            [
              { call: { tool: "search_skills", input: {} } },
              { stop: "end_turn" },
            ],
          ],
        }),
        {},
      );
      try {
        await agent.prompt("list");
        const events = await agent.session.getEvents();
        const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
        expect(tu).toBeTruthy();
        if (tu && tu.sessionUpdate === "tool_call_update") {
          const text =
            tu.content?.[0]?.type === "content" &&
            tu.content[0].content.type === "text"
              ? tu.content[0].content.text
              : "";
          const parsed = JSON.parse(text) as Array<{ name: string }>;
          const names = parsed.map((s) => s.name);
          expect(names).toContain("safe-skill");
          expect(names).toContain("net-skill");
        }
      } finally {
        await agent.close();
      }
    } finally {
      if (old === undefined) delete process.env.LOOM_HOME;
      else process.env.LOOM_HOME = old;
      await cleanup();
    }
  });

  it("add_skill within ceiling: silent (no permission prompt)", async () => {
    const { home, cleanup } = await buildHomeWithSkills();
    const old = process.env.LOOM_HOME;
    process.env.LOOM_HOME = home;
    try {
      const manifest = buildAgent({
        script: [
          [
            {
              call: {
                tool: "add_skill",
                input: { name: "safe-skill" },
              },
            },
            { stop: "end_turn" },
          ],
          // Second turn: the new tool 'reverse' is now available.
          [
            { call: { tool: "reverse", input: { text: "hello" } } },
            { stop: "end_turn" },
          ],
        ],
      });
      let prompted = 0;
      const handler: PermissionHandler = (req) => {
        prompted += 1;
        void req;
        return { decision: "allow_session" };
      };
      const agent = await runAgent(manifest, {
        permissionHandler: handler,
      });
      try {
        await agent.prompt("add it");
        await agent.prompt("use it");
        const events = await agent.session.getEvents();
        const updates = events.filter(
          (e) => e.sessionUpdate === "tool_call_update",
        );
        expect(updates).toHaveLength(2);
        // First: add_skill succeeded.
        if (updates[0]?.sessionUpdate === "tool_call_update") {
          expect(updates[0].status).toBe("completed");
          const t =
            updates[0].content?.[0]?.type === "content" &&
            updates[0].content[0].content.type === "text"
              ? updates[0].content[0].content.text
              : "";
          const parsed = JSON.parse(t);
          expect(parsed.added).toBe("safe-skill");
          expect(parsed.ceilingChanged).toBe(false);
        }
        // Second: reverse worked.
        if (updates[1]?.sessionUpdate === "tool_call_update") {
          expect(updates[1].status).toBe("completed");
          const t =
            updates[1].content?.[0]?.type === "content" &&
            updates[1].content[0].content.type === "text"
              ? updates[1].content[0].content.text
              : "";
          expect(t).toBe("olleh");
        }
        // No permission prompt should have fired.
        expect(prompted).toBe(0);

        // listSkills now reflects the new skill.
        expect(agent.agentState.hasSkill("safe-skill")).toBe(true);
        expect(agent.agentState.hasTool("reverse")).toBe(true);
      } finally {
        await agent.close();
      }
    } finally {
      if (old === undefined) delete process.env.LOOM_HOME;
      else process.env.LOOM_HOME = old;
      await cleanup();
    }
  });

  it("add_skill exceeding ceiling: prompts; deny → fails; allow → succeeds", async () => {
    const { home, cleanup } = await buildHomeWithSkills();
    const old = process.env.LOOM_HOME;
    process.env.LOOM_HOME = home;

    // A) deny path
    {
      {
        const manifest = buildAgent({
          script: [
            [
              { call: { tool: "add_skill", input: { name: "net-skill" } } },
              { stop: "end_turn" },
            ],
          ],
        });
        const requests: PermissionRequest[] = [];
        const handler: PermissionHandler = (req): PermissionResult => {
          requests.push(req);
          return { decision: "deny" };
        };
        const agent = await runAgent(manifest, {
          permissionHandler: handler,
        });
        try {
          await agent.prompt("try");
          const events = await agent.session.getEvents();
          const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
          expect(tu?.sessionUpdate === "tool_call_update" && tu.status).toBe(
            "failed",
          );
          expect(requests).toHaveLength(1);
          expect(requests[0]?.kind).toBe("expand_sandbox");
          expect(requests[0]?.newCapabilities).toEqual({
            network: ["extra.example.com"],
          });
          // State must not have changed.
          expect(agent.agentState.hasSkill("net-skill")).toBe(false);
          expect(agent.agentState.hasTool("pingish")).toBe(false);
        } finally {
          await agent.close();
        }
      }
    }

    // B) allow path
    {
      {
        const manifest = buildAgent({
          script: [
            [
              { call: { tool: "add_skill", input: { name: "net-skill" } } },
              { stop: "end_turn" },
            ],
            [
              { call: { tool: "pingish", input: { host: "h" } } },
              { stop: "end_turn" },
            ],
          ],
        });
        const requests: PermissionRequest[] = [];
        const handler: PermissionHandler = (req): PermissionResult => {
          requests.push(req);
          return { decision: "allow_session" };
        };
        const agent = await runAgent(manifest, {
          permissionHandler: handler,
        });
        try {
          await agent.prompt("expand");
          await agent.prompt("use");
          const events = await agent.session.getEvents();
          const tus = events.filter(
            (e) => e.sessionUpdate === "tool_call_update",
          );
          expect(tus).toHaveLength(2);
          if (tus[0]?.sessionUpdate === "tool_call_update") {
            expect(tus[0].status).toBe("completed");
          }
          if (tus[1]?.sessionUpdate === "tool_call_update") {
            expect(tus[1].status).toBe("completed");
            const t =
              tus[1].content?.[0]?.type === "content" &&
              tus[1].content[0].content.type === "text"
                ? tus[1].content[0].content.text
                : "";
            expect(t).toBe("ping h");
          }
          expect(requests).toHaveLength(1);
          expect(agent.agentState.hasSkill("net-skill")).toBe(true);
          expect(agent.agentState.hasTool("pingish")).toBe(true);
          expect(agent.agentState.ceiling.network).toContain(
            "extra.example.com",
          );
        } finally {
          await agent.close();
        }
      }
    }

    if (old === undefined) delete process.env.LOOM_HOME;
    else process.env.LOOM_HOME = old;
    await cleanup();
  });

  it("no permission handler → ceiling-exceeding add_skill fails closed", async () => {
    const { home, cleanup } = await buildHomeWithSkills();
    const old = process.env.LOOM_HOME;
    process.env.LOOM_HOME = home;
    try {
      const manifest = buildAgent({
        script: [
          [
            { call: { tool: "add_skill", input: { name: "net-skill" } } },
            { stop: "end_turn" },
          ],
        ],
      });
      // No permissionHandler passed → default deny-all.
      const agent = await runAgent(manifest, {});
      try {
        await agent.prompt("try");
        const events = await agent.session.getEvents();
        const tu = events.find((e) => e.sessionUpdate === "tool_call_update");
        expect(tu?.sessionUpdate === "tool_call_update" && tu.status).toBe(
          "failed",
        );
      } finally {
        await agent.close();
      }
    } finally {
      if (old === undefined) delete process.env.LOOM_HOME;
      else process.env.LOOM_HOME = old;
      await cleanup();
    }
  });

  it("allowAll / denyAll convenience handlers behave as expected", async () => {
    const { home, cleanup } = await buildHomeWithSkills();
    const old = process.env.LOOM_HOME;
    process.env.LOOM_HOME = home;
    try {
      const manifest = buildAgent({
        script: [
          [
            { call: { tool: "add_skill", input: { name: "net-skill" } } },
            { stop: "end_turn" },
          ],
        ],
      });

      const a = await runAgent(manifest, {
        permissionHandler: allowAllPermissionHandler,
      });
      try {
        await a.prompt("go");
        expect(a.agentState.hasSkill("net-skill")).toBe(true);
      } finally {
        await a.close();
      }

      const b = await runAgent(manifest, {
        permissionHandler: denyAllPermissionHandler,
      });
      try {
        await b.prompt("go");
        expect(b.agentState.hasSkill("net-skill")).toBe(false);
      } finally {
        await b.close();
      }
      void FIXTURES;
    } finally {
      if (old === undefined) delete process.env.LOOM_HOME;
      else process.env.LOOM_HOME = old;
      await cleanup();
    }
  });
});
