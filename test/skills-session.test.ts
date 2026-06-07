import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  parseFrontmatter,
  resolveConfiguredSkillRoots,
  SkillsSession,
  skillsSessionFactory,
} from "../src/builtins/session/skills.js";
import { DEFAULT_CLIENT_ACP_CAPABILITIES } from "../src/runtime/acp-capabilities.js";
import { auditAgent } from "../src/audit/audit.js";
import { runAgent } from "../src/sdk/run-agent.js";
import type { AgentManifest, Capabilities } from "../src/types/manifest.js";
import type { Agent, Harness, Runtime } from "../src/types/interfaces.js";
import { useTmpDir } from "./helpers/tmp.js";

const tmp = useTmpDir("loom-skills-");

async function writeSkill(
  rel: string,
  frontmatter: string,
  body = "Body content.",
): Promise<string> {
  const dir = path.join(tmp(), rel);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  await fs.writeFile(file, `---\n${frontmatter}\n---\n${body}\n`, "utf8");
  return dir;
}

function factoryContext(storage: string, purpose?: "run" | "audit") {
  return {
    manifestDir: storage,
    agentName: "x",
    loomVersion: "test",
    clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
    ...(purpose ? { purpose } : {}),
    storage,
    metadata: {},
  };
}

function stubAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    manifest: { name: "stub", harness: { provider: "test" } },
    harness: {} as Harness,
    session: {},
    systemPromptCore: "",
    ...overrides,
  };
}

const stopHarness: Harness = {
  async run(rt: Runtime) {
    await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
    return { stopReason: "end_turn" as const };
  },
};

describe("parseFrontmatter", () => {
  it("extracts required name and description", () => {
    const fm = parseFrontmatter(
      "name: pdf-processing\ndescription: Extract PDF text. Use when handling PDFs.",
    );
    expect(fm.name).toBe("pdf-processing");
    expect(fm.description).toBe("Extract PDF text. Use when handling PDFs.");
  });

  it("throws on missing required fields", () => {
    expect(() => parseFrontmatter("name: foo")).toThrow(/description/);
    expect(() => parseFrontmatter("description: bar")).toThrow(/name/);
  });

  it("captures optional metadata as a sub-mapping", () => {
    const fm = parseFrontmatter(
      [
        "name: foo",
        "description: bar",
        "metadata:",
        "  author: example-org",
        '  version: "1.0"',
      ].join("\n"),
    );
    expect(fm.metadata).toEqual({ author: "example-org", version: "1.0" });
  });

  it("captures the spec's allowed-tools field verbatim", () => {
    const fm = parseFrontmatter(
      "name: foo\ndescription: bar\nallowed-tools: Bash(git:*) Bash(jq:*) Read",
    );
    expect(fm.allowedTools).toBe("Bash(git:*) Bash(jq:*) Read");
  });
});

describe("tool group compilation", () => {
  it("derives a read-only declaration over the skill dir when nothing is declared", async () => {
    const dir = await writeSkill("plain", "name: plain\ndescription: Docs.");
    const session = new SkillsSession({ roots: [tmp()], purpose: "run" });
    const groups = await session.tools();
    expect(groups).toEqual([
      {
        label: "skill 'plain'",
        tools: {
          read_file: { capabilities: { paths: [dir] } },
        },
      },
    ]);
  });

  it("compiles loom.tools frontmatter with ${SKILL_DIR} substitution", async () => {
    const dir = await writeSkill(
      "calendar",
      [
        "name: calendar",
        "description: Calendar via gcalcli.",
        "metadata:",
        "  loom.tools: |",
        '    bash = { capabilities = { commands = ["gcalcli"], network = "*" } }',
        '    read_file = { capabilities = { paths = ["${SKILL_DIR}"] } }',
      ].join("\n"),
    );
    const session = new SkillsSession({ roots: [tmp()], purpose: "run" });
    const groups = await session.tools();
    expect(groups).toEqual([
      {
        label: "skill 'calendar'",
        tools: {
          bash: {
            capabilities: { commands: ["gcalcli"], network: "*" },
          },
          read_file: { capabilities: { paths: [dir] } },
        },
      },
    ]);
  });

  it("prefers a loom.toml sidecar over frontmatter entirely", async () => {
    const dir = await writeSkill(
      "enhanced",
      [
        "name: enhanced",
        "description: Has both.",
        "metadata:",
        "  loom.tools: |",
        '    bash = { capabilities = { commands = "*" } }',
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(dir, "loom.toml"),
      `[tools]\nread_file = { capabilities = { paths = ["\${SKILL_DIR}/references"] } }\n`,
      "utf8",
    );
    const session = new SkillsSession({ roots: [tmp()], purpose: "run" });
    const groups = await session.tools();
    expect(groups).toEqual([
      {
        label: "skill 'enhanced'",
        tools: {
          read_file: {
            capabilities: { paths: [path.join(dir, "references")] },
          },
        },
      },
    ]);
  });

  it("skips skills whose loom.tools is invalid TOML or has unsupported keys", async () => {
    await writeSkill(
      "broken-toml",
      [
        "name: broken-toml",
        "description: Bad.",
        "metadata:",
        "  loom.tools: |",
        "    bash = = nope",
      ].join("\n"),
    );
    await writeSkill(
      "smuggler",
      [
        "name: smuggler",
        "description: Tries config.",
        "metadata:",
        "  loom.tools: |",
        '    bash = { capabilities = { commands = "*" }, api_key = "x" }',
      ].join("\n"),
    );
    await writeSkill("good", "name: good\ndescription: Works.");
    const session = new SkillsSession({ roots: [tmp()], purpose: "run" });
    const groups = await session.tools();
    expect(groups.map((f) => f.label)).toEqual(["skill 'good'"]);
  });
});

describe("SkillsSession discovery", () => {
  it("finds skills directly under a root, sorted by name", async () => {
    await writeSkill("pdf", "name: pdf\ndescription: PDFs.");
    await writeSkill("data", "name: data\ndescription: Data.");
    const session = new SkillsSession({ roots: [tmp()], purpose: "run" });
    const section = await session.systemPromptSection(stubAgent());
    expect(section).toContain("**data**");
    expect(section).toContain("**pdf**");
    expect(section.indexOf("**data**")).toBeLessThan(
      section.indexOf("**pdf**"),
    );
  });

  it("finds skills nested under category folders", async () => {
    await writeSkill("docs/pdf", "name: pdf\ndescription: PDFs.");
    await writeSkill("data/csv", "name: csv\ndescription: CSV.");
    const session = new SkillsSession({ roots: [tmp()], purpose: "run" });
    const section = await session.systemPromptSection(stubAgent());
    expect(section).toContain("**csv**");
    expect(section).toContain("**pdf**");
  });

  it("stops at the outer SKILL.md and ignores nested ones", async () => {
    await writeSkill("wrap", "name: wrap\ndescription: outer.");
    const innerDir = path.join(tmp(), "wrap", "scripts");
    await fs.mkdir(innerDir, { recursive: true });
    await fs.writeFile(
      path.join(innerDir, "SKILL.md"),
      "---\nname: inner\ndescription: should not be discovered\n---\n",
      "utf8",
    );
    const session = new SkillsSession({ roots: [tmp()], purpose: "run" });
    const section = await session.systemPromptSection(stubAgent());
    expect(section).toContain("**wrap**");
    expect(section).not.toContain("**inner**");
  });

  it("returns an empty section for missing roots or no skills", async () => {
    const missing = new SkillsSession({
      roots: [path.join(tmp(), "does-not-exist")],
      purpose: "run",
    });
    expect(await missing.systemPromptSection(stubAgent())).toBe("");

    const empty = new SkillsSession({ roots: [tmp()], purpose: "run" });
    expect(await empty.systemPromptSection(stubAgent())).toBe("");
  });

  it("skips malformed SKILL.md files without crashing", async () => {
    await fs.mkdir(path.join(tmp(), "broken"), { recursive: true });
    await fs.writeFile(
      path.join(tmp(), "broken", "SKILL.md"),
      "---\nname: broken\n---\nbody\n",
      "utf8",
    );
    await writeSkill("good", "name: good\ndescription: Works.");
    const session = new SkillsSession({ roots: [tmp()], purpose: "run" });
    const section = await session.systemPromptSection(stubAgent());
    expect(section).toContain("**good**");
    expect(section).not.toContain("**broken**");
  });

  it("rescans on prepareTurn so new skills appear", async () => {
    await writeSkill("a", "name: a\ndescription: First.");
    const session = new SkillsSession({ roots: [tmp()], purpose: "run" });
    let section = await session.systemPromptSection(stubAgent());
    expect(section).toContain("**a**");
    expect(section).not.toContain("**b**");

    await writeSkill("b", "name: b\ndescription: Second.");
    await session.prepareTurn();
    section = await session.systemPromptSection(stubAgent());
    expect(section).toContain("**a**");
    expect(section).toContain("**b**");
  });
});

describe("catalog trimming", () => {
  it("hides skills whose boot verdict rejected them under purpose 'run'", async () => {
    await writeSkill("denied", "name: denied\ndescription: Wants too much.");
    await writeSkill("granted", "name: granted\ndescription: Fits.");
    const session = new SkillsSession({ roots: [tmp()], purpose: "run" });
    const agent = stubAgent({
      toolVerdicts: [
        {
          label: "skill 'denied'",
          accepted: false,
          declarations: [
            {
              instance: "bash",
              underlying: "bash",
              ok: false,
              reason: "request exceeds [capabilities].bash",
            },
          ],
        },
        { label: "skill 'granted'", accepted: true, declarations: [] },
      ],
    });
    const section = await session.systemPromptSection(agent);
    expect(section).toContain("**granted**");
    expect(section).not.toContain("denied");
  });

  it("annotates rejected skills instead of hiding them under purpose 'audit'", async () => {
    await writeSkill("denied", "name: denied\ndescription: Wants too much.");
    const session = new SkillsSession({ roots: [tmp()], purpose: "audit" });
    const agent = stubAgent({
      toolVerdicts: [
        {
          label: "skill 'denied'",
          accepted: false,
          declarations: [
            {
              instance: "bash",
              underlying: "bash",
              ok: false,
              reason: "request exceeds [capabilities].bash",
            },
          ],
        },
      ],
    });
    const section = await session.systemPromptSection(agent);
    expect(section).toContain("**denied** — INACTIVE");
    expect(section).toContain("request exceeds [capabilities].bash");
  });

  it("trims post-boot skills subtractively: new tool declarations need a restart, qualifying reads pass", async () => {
    const dirA = await writeSkill(
      "late-reader",
      "name: late-reader\ndescription: Reads only.",
    );
    await writeSkill(
      "late-tool",
      [
        "name: late-tool",
        "description: Declares an instance.",
        "metadata:",
        "  loom.tools: |",
        '    jq = { provider = "builtin", tool = "bash", capabilities = { commands = ["jq"] } }',
      ].join("\n"),
    );
    const session = new SkillsSession({ roots: [tmp()], purpose: "run" });
    const ceiling: Capabilities = {
      read_file: { paths: [path.dirname(dirA)] },
      jq: { commands: ["jq"] },
    };
    // No verdicts at all = nothing was known at boot; both skills are post-boot.
    const agent = stubAgent({ capabilities: ceiling, toolVerdicts: [] });
    const section = await session.systemPromptSection(agent);
    expect(section).toContain("**late-reader**");
    expect(section).not.toContain("late-tool");
  });
});

describe("skillsSessionFactory", () => {
  it("defaults to ~/.skills when no config is given", () => {
    const roots = resolveConfiguredSkillRoots({}, tmp());
    expect(roots).toEqual([path.join(os.homedir(), ".skills")]);
  });

  it("resolves a relative root against the manifest dir", () => {
    const roots = resolveConfiguredSkillRoots({ root: "./skills" }, tmp());
    expect(roots).toEqual([path.join(tmp(), "skills")]);
  });

  it("accepts a `roots` array", () => {
    const roots = resolveConfiguredSkillRoots(
      { roots: [tmp(), "~/elsewhere"] },
      tmp(),
    );
    expect(roots).toEqual([tmp(), path.join(os.homedir(), "elsewhere")]);
  });

  it("rejects the removed default_tools config with a teaching error", () => {
    expect(() =>
      skillsSessionFactory.create(
        { default_tools: ["bash"] },
        factoryContext(tmp()),
        {},
      ),
    ).toThrow(/no longer exists/);
  });
});

describe("skills via runAgent", () => {
  it("binds an accepted skill row onto an existing instance and reports the verdict", async () => {
    const dir = await writeSkill(
      "calendar",
      [
        "name: calendar",
        "description: Calendar.",
        "metadata:",
        "  loom.tools: |",
        '    bash = { capabilities = { commands = ["gcalcli"], network = "*" } }',
        '    read_file = { capabilities = { paths = ["${SKILL_DIR}"] } }',
      ].join("\n"),
    );
    const manifest: AgentManifest = {
      name: "skills-e2e",
      systemPrompt: "x",
      tools: { bash: "builtin", read_file: "builtin" },
      capabilities: {
        bash: [
          { commands: "*", paths: ["./"] },
          { commands: ["gcalcli"], network: "*" },
        ],
        read_file: { paths: ["./", tmp()] },
      },
      session: [{ provider: "skills", root: tmp() }, { provider: "in-memory" }],
      harness: stopHarness,
    };
    const agent = await runAgent(manifest);
    try {
      expect(agent.agentState.toolTable.list().map((t) => t.name)).toEqual(
        expect.arrayContaining(["bash", "read_file"]),
      );
      const verdicts = agent.toolVerdicts ?? [];
      expect(verdicts).toEqual([
        {
          label: "skill 'calendar'",
          accepted: true,
          declarations: [
            {
              instance: "bash",
              underlying: "bash",
              ok: true,
              against: "bash",
            },
            {
              instance: "read_file",
              underlying: "read_file",
              ok: true,
              against: "read_file",
            },
          ],
        },
      ]);
      const bash = agent.agentState.toolTable
        .list()
        .find((t) => t.name === "bash");
      // The contribution must EXTEND the bare entry's ceiling request: the
      // general row survives (shell mode) alongside the per-command row.
      expect(bash?.description).toContain("Run a bash command");
      expect(bash?.description).toContain("gcalcli");
      const readFile = agent.agentState.toolTable
        .list()
        .find((t) => t.name === "read_file");
      expect(readFile?.description).toContain(path.resolve("."));
      expect(readFile?.description).toContain(tmp());
      void dir;
    } finally {
      await agent.close();
    }
  });

  it("binds a skill-declared renamed instance with its narrow grant", async () => {
    await writeSkill(
      "jq-skill",
      [
        "name: jq-skill",
        "description: jq runner.",
        "metadata:",
        "  loom.tools: |",
        '    jq = { provider = "builtin", tool = "bash", capabilities = { commands = ["jq"], paths = ["./"] } }',
        '    read_file = { capabilities = { paths = ["${SKILL_DIR}"] } }',
      ].join("\n"),
    );
    const manifest: AgentManifest = {
      name: "rename-e2e",
      systemPrompt: "x",
      tools: { read_file: "builtin" },
      capabilities: {
        read_file: { paths: ["./", tmp()] },
        jq: { commands: ["jq"], paths: ["./"] },
      },
      session: [{ provider: "skills", root: tmp() }, { provider: "in-memory" }],
      harness: stopHarness,
    };
    const agent = await runAgent(manifest);
    try {
      const names = agent.agentState.toolTable.list().map((t) => t.name);
      expect(names).toContain("jq");
      expect(names).toContain("read_file");
      const jq = agent.agentState.toolTable.list().find((t) => t.name === "jq");
      expect(jq?.description).toContain("jq");
    } finally {
      await agent.close();
    }
  });

  it("rejects a fragment exceeding the ceiling, fail-soft, with remediation", async () => {
    await writeSkill(
      "greedy",
      [
        "name: greedy",
        "description: Wants the network.",
        "metadata:",
        "  loom.tools: |",
        '    bash = { capabilities = { commands = "*", network = "*" } }',
      ].join("\n"),
    );
    const manifest: AgentManifest = {
      name: "reject-e2e",
      systemPrompt: "x",
      tools: { bash: "builtin" },
      capabilities: {
        bash: { commands: "*", paths: ["./"] },
      },
      session: [{ provider: "skills", root: tmp() }, { provider: "in-memory" }],
      harness: stopHarness,
    };
    const agent = await runAgent(manifest);
    try {
      const verdicts = agent.toolVerdicts ?? [];
      expect(verdicts).toHaveLength(1);
      const verdict = verdicts[0]!;
      expect(verdict.label).toBe("skill 'greedy'");
      expect(verdict.accepted).toBe(false);
      const declaration = verdict.declarations[0]!;
      expect(declaration.ok).toBe(false);
      expect(declaration.reason).toBe("request exceeds [capabilities].bash");
      expect(declaration.remediation).toBe(
        'bash = { commands = "*", network = "*" }',
      );
    } finally {
      await agent.close();
    }
  });

  it("rejected skills are trimmed from the live turn's system prompt", async () => {
    await writeSkill("plain", "name: plain\ndescription: Just docs.");
    await writeSkill(
      "greedy",
      [
        "name: greedy",
        "description: Wants the network.",
        "metadata:",
        "  loom.tools: |",
        '    bash = { capabilities = { commands = "*", network = "*" } }',
      ].join("\n"),
    );
    let promptSeen = "";
    const capturingHarness: Harness = {
      async run(rt: Runtime) {
        promptSeen = rt.systemPrompt();
        await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return { stopReason: "end_turn" as const };
      },
    };
    const manifest: AgentManifest = {
      name: "trim-e2e",
      systemPrompt: "x",
      tools: { bash: "builtin", read_file: "builtin" },
      capabilities: {
        bash: { commands: "*", paths: ["./"] },
        read_file: { paths: ["./", tmp()] },
      },
      session: [{ provider: "skills", root: tmp() }, { provider: "in-memory" }],
      harness: capturingHarness,
    };
    const agent = await runAgent(manifest);
    try {
      await agent.prompt("hello");
      expect(promptSeen).toContain("**plain**");
      expect(promptSeen).not.toContain("greedy");
    } finally {
      await agent.close();
    }
  });

  it("skills work with no [capabilities] via the default ceiling (reads yes, network no)", async () => {
    await writeSkill("reader", "name: reader\ndescription: Just docs.");
    await writeSkill(
      "networker",
      [
        "name: networker",
        "description: Wants curl.",
        "metadata:",
        "  loom.tools: |",
        '    bash = { capabilities = { commands = ["curl"], network = "*" } }',
      ].join("\n"),
    );
    const manifest: AgentManifest = {
      name: "default-tier-e2e",
      systemPrompt: "x",
      session: [{ provider: "skills", root: tmp() }, { provider: "in-memory" }],
      harness: stopHarness,
    };
    const agent = await runAgent(manifest);
    try {
      const byLabel = new Map(
        (agent.toolVerdicts ?? []).map((v) => [v.label, v]),
      );
      expect(byLabel.get("skill 'reader'")?.accepted).toBe(true);
      expect(byLabel.get("skill 'networker'")?.accepted).toBe(false);
      const readFile = agent.agentState.toolTable
        .list()
        .find((t) => t.name === "read_file");
      expect(readFile?.description).toContain(tmp());
    } finally {
      await agent.close();
    }
  });
});

describe("skills shipping providers", () => {
  const FIXTURES = path.resolve("test/fixtures");
  const ECHO_SERVER = path.join(FIXTURES, "mcp/echo-server.mjs");

  it("binds a skill-shipped MCP server accepted by instance name, deduping with an equal manifest provider", async () => {
    await writeSkill(
      "echo-skill",
      [
        "name: echo-skill",
        "description: Echoes via its own bundled MCP server.",
        "metadata:",
        "  loom.providers: |",
        `    server = { provider = "mcp-server", command = "node", args = ["${ECHO_SERVER}"] }`,
        "  loom.tools: |",
        '    skill_echo = { provider = "server", tool = "echo", capabilities = "*" }',
      ].join("\n"),
    );
    const manifest: AgentManifest = {
      name: "skill-provider-e2e",
      systemPrompt: "x",
      providers: {
        // Equal value to the skill's group-local provider: must dedup to
        // ONE server process.
        echo_mcp: {
          provider: "mcp-server",
          command: "node",
          args: [ECHO_SERVER],
        },
      },
      tools: { echo: { provider: "echo_mcp", capabilities: "*" } },
      capabilities: {
        echo: "*",
        skill_echo: "*", // instance-name acceptance for the skill's tool
        read_file: { paths: ["./", tmp()] },
      },
      session: [{ provider: "skills", root: tmp() }, { provider: "in-memory" }],
      harness: stopHarness,
    };
    const agent = await runAgent(manifest);
    try {
      const verdict = agent.toolVerdicts.find(
        (v) => v.label === "skill 'echo-skill'",
      );
      expect(verdict?.accepted).toBe(true);

      const result = await agent.agentState.toolTable.execute({
        id: "t1",
        name: "skill_echo",
        input: { text: "hello from a skill-shipped server" },
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("hello from a skill-shipped server");
    } finally {
      await agent.close();
    }

    const tree = await auditAgent(manifest);
    const mcpProviders = tree.providers.filter(
      (p) => p.factoryName === "mcp-server",
    );
    expect(mcpProviders).toHaveLength(1);
  });

  it("rejects a skill-shipped server without instance-name acceptance", async () => {
    await writeSkill(
      "unsanctioned",
      [
        "name: unsanctioned",
        "description: Ships a server nobody accepted.",
        "metadata:",
        "  loom.providers: |",
        `    server = { provider = "mcp-server", command = "node", args = ["${ECHO_SERVER}"] }`,
        "  loom.tools: |",
        '    sneaky = { provider = "server", tool = "echo" }',
      ].join("\n"),
    );
    const manifest: AgentManifest = {
      name: "unsanctioned-e2e",
      systemPrompt: "x",
      tools: { read_file: "builtin" },
      capabilities: { read_file: { paths: ["./", tmp()] } },
      session: [{ provider: "skills", root: tmp() }, { provider: "in-memory" }],
      harness: stopHarness,
    };
    const agent = await runAgent(manifest);
    try {
      const verdict = agent.toolVerdicts.find(
        (v) => v.label === "skill 'unsanctioned'",
      );
      expect(verdict?.accepted).toBe(false);
      expect(verdict?.declarations[0]?.reason).toContain(
        "ships its own implementation",
      );
      const names = agent.agentState.toolTable.list().map((t) => t.name);
      expect(names).not.toContain("sneaky");
    } finally {
      await agent.close();
    }
  });
});

describe("auditAgent + skills session", () => {
  it("surfaces fragment verdicts in the tree", async () => {
    const dir = await writeSkill("ops", "name: ops\ndescription: Ops docs.");
    const manifest: AgentManifest = {
      name: "audit-skills",
      systemPrompt: "x",
      tools: { read_file: "builtin" },
      capabilities: {
        read_file: { paths: ["./", tmp()] },
      },
      session: [{ provider: "skills", root: tmp() }, { provider: "in-memory" }],
      harness: { provider: "test" },
    };
    const tree = await auditAgent(manifest);
    expect(tree.toolGroups).toEqual([
      {
        label: "skill 'ops'",
        accepted: true,
        declarations: [
          {
            instance: "read_file",
            underlying: "read_file",
            ok: true,
            against: "read_file",
          },
        ],
      },
    ]);
    expect(tree.sessionConstructionError).toBeUndefined();
    void dir;
  });

  it("records a construction error for parent-derived sessions at the top level", async () => {
    const manifest: AgentManifest = {
      name: "audit-needs-parent",
      systemPrompt: "x",
      tools: { read_file: "builtin" },
      capabilities: { read_file: { paths: ["./"] } },
      session: { provider: "fork-of-parent" },
      harness: { provider: "test" },
    };
    const tree = await auditAgent(manifest);
    expect(tree.sessionConstructionError).toMatch(/parent/i);
    expect(tree.toolGroups).toEqual([]);
  });
});
