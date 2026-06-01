import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  parseFrontmatter,
  SkillsSession,
  skillsSessionFactory,
} from "../src/builtins/session/skills.js";
import { DEFAULT_CLIENT_ACP_CAPABILITIES } from "../src/runtime/acp-capabilities.js";
import { auditAgent } from "../src/audit/audit.js";
import { runAgent } from "../src/sdk/run-agent.js";
import type { AgentManifest } from "../src/types/manifest.js";
import type { Harness, Runtime } from "../src/types/interfaces.js";
import { useTmpDir, withTmpDir } from "./helpers/tmp.js";

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
  return file;
}

function factoryContext(storage: string) {
  return {
    manifestDir: storage,
    agentName: "x",
    loomVersion: "test",
    clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
    storage,
    metadata: {},
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

  it("handles literal and folded block scalars for description", () => {
    const literal = parseFrontmatter(
      ["name: foo", "description: |", "  Line one.", "  Line two."].join("\n"),
    );
    expect(literal.description).toBe("Line one.\nLine two.");

    const folded = parseFrontmatter(
      ["name: foo", "description: >", "  Line one.", "  Line two."].join("\n"),
    );
    expect(folded.description).toBe("Line one. Line two.");
  });

  it("strips surrounding quotes from inline values", () => {
    const fm = parseFrontmatter(`name: "foo"\ndescription: 'bar baz'`);
    expect(fm.name).toBe("foo");
    expect(fm.description).toBe("bar baz");
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

  it("reads loom.required-tools from metadata, blank opts out, absent stays undefined", () => {
    const declared = parseFrontmatter(
      [
        "name: foo",
        "description: bar",
        "metadata:",
        '  loom.required-tools: "bash read_file"',
      ].join("\n"),
    );
    expect(declared.requiredTools).toEqual(["bash", "read_file"]);

    const blank = parseFrontmatter(
      [
        "name: foo",
        "description: bar",
        "metadata:",
        '  loom.required-tools: ""',
      ].join("\n"),
    );
    expect(blank.requiredTools).toEqual([]);

    const absent = parseFrontmatter(
      ["name: foo", "description: bar", "metadata:", "  author: someone"].join(
        "\n",
      ),
    );
    expect(absent.requiredTools).toBeUndefined();
  });

  it("captures the spec's allowed-tools field verbatim", () => {
    const fm = parseFrontmatter(
      "name: foo\ndescription: bar\nallowed-tools: Bash(git:*) Bash(jq:*) Read",
    );
    expect(fm.allowedTools).toBe("Bash(git:*) Bash(jq:*) Read");
  });
});

describe("SkillsSession discovery", () => {
  it("finds skills directly under a root, sorted by name", async () => {
    await writeSkill("pdf", "name: pdf\ndescription: PDFs.");
    await writeSkill("data", "name: data\ndescription: Data.");
    const session = new SkillsSession({ roots: [tmp()] });
    const section = await session.systemPromptSection();
    expect(section).toContain("**data**");
    expect(section).toContain("**pdf**");
    expect(section.indexOf("**data**")).toBeLessThan(
      section.indexOf("**pdf**"),
    );
  });

  it("finds skills nested under category folders", async () => {
    await writeSkill("docs/pdf", "name: pdf\ndescription: PDFs.");
    await writeSkill("data/csv", "name: csv\ndescription: CSV.");
    const session = new SkillsSession({ roots: [tmp()] });
    const section = await session.systemPromptSection();
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
    const session = new SkillsSession({ roots: [tmp()] });
    const section = await session.systemPromptSection();
    expect(section).toContain("**wrap**");
    expect(section).not.toContain("**inner**");
  });

  it("returns an empty section for missing roots or no skills", async () => {
    const missing = new SkillsSession({
      roots: [path.join(tmp(), "does-not-exist")],
    });
    expect(await missing.systemPromptSection()).toBe("");

    const empty = new SkillsSession({ roots: [tmp()] });
    expect(await empty.systemPromptSection()).toBe("");
  });

  it("skips malformed SKILL.md files without crashing", async () => {
    await fs.mkdir(path.join(tmp(), "broken"), { recursive: true });
    await fs.writeFile(
      path.join(tmp(), "broken", "SKILL.md"),
      "---\nname: broken\n---\nbody\n",
      "utf8",
    );
    await writeSkill("good", "name: good\ndescription: Works.");
    const session = new SkillsSession({ roots: [tmp()] });
    const section = await session.systemPromptSection();
    expect(section).toContain("**good**");
    expect(section).not.toContain("**broken**");
  });

  it("rescans on prepareTurn so new skills appear", async () => {
    await writeSkill("a", "name: a\ndescription: First.");
    const session = new SkillsSession({ roots: [tmp()] });
    let section = await session.systemPromptSection();
    expect(section).toContain("**a**");
    expect(section).not.toContain("**b**");

    await writeSkill("b", "name: b\ndescription: Second.");
    await session.prepareTurn();
    section = await session.systemPromptSection();
    expect(section).toContain("**a**");
    expect(section).toContain("**b**");
  });
});

describe("SkillsSession contributions", () => {
  it("advertises configured roots as read-only trusted paths", async () => {
    const session = new SkillsSession({ roots: [tmp()] });
    const trusted = await session.trustedPaths();
    expect(trusted).toHaveLength(1);
    expect(trusted[0]?.path).toBe(tmp());
    expect(trusted[0]?.access).toBe("read");
    expect(trusted[0]?.reason).toMatch(/Agent Skills root/i);
  });

  it("aggregates required-tools across skills, deduped, with no session config", async () => {
    await writeSkill(
      "a",
      [
        "name: a",
        "description: A.",
        "metadata:",
        '  loom.required-tools: "bash read_file"',
      ].join("\n"),
    );
    await writeSkill(
      "b",
      [
        "name: b",
        "description: B.",
        "metadata:",
        '  loom.required-tools: "bash"',
      ].join("\n"),
    );
    const session = new SkillsSession({ roots: [tmp()] });
    const tools = await session.tools();
    expect(tools.map((t) => t.name).sort()).toEqual(["bash", "read_file"]);
    for (const t of tools) expect(t.config).toEqual({});
  });

  it("applies default_tools to skills that don't declare, honoring overrides", async () => {
    await writeSkill("a", "name: a\ndescription: A.");

    const fallback = new SkillsSession({ roots: [tmp()] });
    expect((await fallback.tools()).map((t) => t.name)).toEqual(["bash"]);

    const overridden = new SkillsSession({
      roots: [tmp()],
      defaultTools: ["read_file"],
    });
    expect((await overridden.tools()).map((t) => t.name)).toEqual([
      "read_file",
    ]);

    const disabled = new SkillsSession({ roots: [tmp()], defaultTools: [] });
    expect(await disabled.tools()).toEqual([]);
  });

  it("an explicit empty required-tools opts that skill out of the default", async () => {
    await writeSkill(
      "text-only",
      [
        "name: text-only",
        "description: Pure docs.",
        "metadata:",
        '  loom.required-tools: ""',
      ].join("\n"),
    );
    await writeSkill("scripted", "name: scripted\ndescription: Uses bash.");
    const session = new SkillsSession({ roots: [tmp()] });
    const tools = await session.tools();
    expect(tools.map((t) => t.name)).toEqual(["bash"]);
  });
});

describe("skillsSessionFactory", () => {
  it("defaults to ~/.skills when no config is given", async () => {
    const session = skillsSessionFactory.create({}, factoryContext(tmp()), {});
    const trusted = await (session as SkillsSession).trustedPaths();
    expect(trusted[0]?.path).toBe(path.join(os.homedir(), ".skills"));
  });

  it("accepts a single `root`", async () => {
    const session = skillsSessionFactory.create(
      { root: tmp() },
      factoryContext(tmp()),
      {},
    );
    const trusted = await (session as SkillsSession).trustedPaths();
    expect(trusted[0]?.path).toBe(tmp());
  });

  it("accepts a `roots` array", async () => {
    await withTmpDir("loom-skills-2-", async (other) => {
      const session = skillsSessionFactory.create(
        { roots: [tmp(), other] },
        factoryContext(tmp()),
        {},
      );
      const trusted = await (session as SkillsSession).trustedPaths();
      expect(trusted.map((t) => t.path)).toEqual([tmp(), other]);
    });
  });

  it("rejects malformed default_tools", () => {
    expect(() =>
      skillsSessionFactory.create(
        { default_tools: "bash" },
        factoryContext(tmp()),
        {},
      ),
    ).toThrow(/default_tools/);
  });
});

describe("Skills session via runAgent", () => {
  it("registers skill-required tools alongside manifest tools", async () => {
    await writeSkill(
      "writer",
      [
        "name: writer",
        "description: Writes files.",
        "metadata:",
        '  loom.required-tools: "edit_file"',
      ].join("\n"),
    );
    await writeSkill(
      "defaulter",
      "name: defaulter\ndescription: Uses default.",
    );
    const manifest: AgentManifest = {
      name: "skills-e2e",
      systemPrompt: "x",
      tools: { read_file: "builtin" },
      capabilities: {
        read_file: { paths: ["./"] },
        edit_file: { paths: ["./"] },
        bash: { commands: "*", paths: ["./"] },
      },
      // Pair pass-through skills with in-memory so the chain has a storage layer.
      session: [
        { provider: "skills", root: tmp(), default_tools: ["bash"] },
        { provider: "in-memory" },
      ],
      harness: stopHarness,
    };
    const agent = await runAgent(manifest);
    try {
      const names = agent.agentState.toolTable.list().map((t) => t.name);
      expect(names).toContain("read_file");
      expect(names).toContain("edit_file");
      expect(names).toContain("bash");
    } finally {
      await agent.close();
    }
  });

  it("manifest config wins on tool name conflict with no double-registration", async () => {
    await writeSkill(
      "reader",
      [
        "name: reader",
        "description: Reads.",
        "metadata:",
        '  loom.required-tools: "read_file"',
      ].join("\n"),
    );
    const manifest: AgentManifest = {
      name: "dedup-e2e",
      systemPrompt: "x",
      tools: {
        read_file: { provider: "builtin", custom_marker: "from-manifest" },
      },
      capabilities: { read_file: { paths: ["./"] } },
      session: [
        { provider: "skills", root: tmp(), default_tools: [] },
        { provider: "in-memory" },
      ],
      harness: stopHarness,
    };
    const agent = await runAgent(manifest);
    try {
      const matches = agent.agentState.toolTable
        .list()
        .filter((t) => t.name === "read_file");
      expect(matches).toHaveLength(1);
    } finally {
      await agent.close();
    }
  });
});

describe("auditAgent + skills session", () => {
  it("surfaces session-introduced tools and trusted paths in the tree", async () => {
    await writeSkill(
      "ops",
      [
        "name: ops",
        "description: Ops scripts.",
        "metadata:",
        '  loom.required-tools: "bash"',
      ].join("\n"),
    );
    const manifest: AgentManifest = {
      name: "audit-skills",
      systemPrompt: "x",
      tools: { read_file: "builtin" },
      capabilities: {
        read_file: { paths: ["./"] },
        bash: { commands: "*", paths: ["./"] },
      },
      session: { provider: "skills", root: tmp(), default_tools: [] },
      harness: { provider: "test" },
    };
    const tree = await auditAgent(manifest);
    expect(tree.tools.map((t) => t.name).sort()).toEqual(["bash", "read_file"]);
    expect(tree.tools.find((t) => t.name === "bash")?.introducedBy).toMatch(
      /session: skills/,
    );
    expect(tree.trustedPaths).toHaveLength(1);
    expect(tree.trustedPaths[0]?.path).toBe(tmp());
    expect(tree.trustedPaths[0]?.access).toBe("read");
    expect(tree.sessionConstructionError).toBeUndefined();
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
    expect(tree.trustedPaths).toEqual([]);
  });
});
