import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

/**
 * Skill-suite scratch dir per test. Cleaned up in afterEach.
 *
 * Layout per test under TMP/skills/<skill-name>/SKILL.md, optionally with
 * sub-dirs (scripts/, references/, ...).
 */
let TMP: string;

beforeEach(async () => {
  TMP = await fs.mkdtemp(path.join(os.tmpdir(), "loom-skills-"));
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

async function writeSkill(
  rel: string,
  frontmatter: string,
  body = "Body content.",
): Promise<string> {
  const dir = path.join(TMP, rel);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  await fs.writeFile(file, `---\n${frontmatter}\n---\n${body}\n`, "utf8");
  return file;
}

// ──────────────────────────────────────────────────────────────────────
// Frontmatter parser.
// ──────────────────────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  it("extracts required name and description", () => {
    const fm = parseFrontmatter(
      [
        "name: pdf-processing",
        "description: Extract PDF text. Use when handling PDFs.",
      ].join("\n"),
    );
    expect(fm.name).toBe("pdf-processing");
    expect(fm.description).toBe("Extract PDF text. Use when handling PDFs.");
  });

  it("throws on missing required fields", () => {
    expect(() => parseFrontmatter("name: foo")).toThrow(/description/);
    expect(() => parseFrontmatter("description: bar")).toThrow(/name/);
  });

  it("handles a literal block scalar (`|`) for description", () => {
    const fm = parseFrontmatter(
      ["name: foo", "description: |", "  Line one.", "  Line two."].join("\n"),
    );
    expect(fm.description).toBe("Line one.\nLine two.");
  });

  it("handles a folded block scalar (`>`) for description", () => {
    const fm = parseFrontmatter(
      ["name: foo", "description: >", "  Line one.", "  Line two."].join("\n"),
    );
    expect(fm.description).toBe("Line one. Line two.");
  });

  it("strips surrounding quotes from inline values", () => {
    const fm = parseFrontmatter(
      [`name: "foo"`, `description: 'bar baz'`].join("\n"),
    );
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

  it("reads loom.required-tools from inside metadata", () => {
    const fm = parseFrontmatter(
      [
        "name: foo",
        "description: bar",
        "metadata:",
        '  loom.required-tools: "bash read_file"',
      ].join("\n"),
    );
    expect(fm.requiredTools).toEqual(["bash", "read_file"]);
  });

  it("treats loom.required-tools as an empty array when blank", () => {
    // Explicit opt-out — the skill author wants no tools.
    const fm = parseFrontmatter(
      [
        "name: foo",
        "description: bar",
        "metadata:",
        '  loom.required-tools: ""',
      ].join("\n"),
    );
    expect(fm.requiredTools).toEqual([]);
  });

  it("leaves requiredTools undefined when the key is absent", () => {
    // Absence ≠ empty: the session's `default_tools` will apply.
    const fm = parseFrontmatter(
      ["name: foo", "description: bar", "metadata:", "  author: someone"].join(
        "\n",
      ),
    );
    expect(fm.requiredTools).toBeUndefined();
  });

  it("captures the spec's allowed-tools field verbatim", () => {
    const fm = parseFrontmatter(
      [
        "name: foo",
        "description: bar",
        "allowed-tools: Bash(git:*) Bash(jq:*) Read",
      ].join("\n"),
    );
    expect(fm.allowedTools).toBe("Bash(git:*) Bash(jq:*) Read");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Discovery.
// ──────────────────────────────────────────────────────────────────────

describe("SkillsSession discovery", () => {
  it("finds skills directly under a root", async () => {
    await writeSkill("pdf", "name: pdf\ndescription: PDFs.");
    await writeSkill("data", "name: data\ndescription: Data.");
    const session = new SkillsSession({ roots: [TMP] });
    const section = await session.systemPromptSection();
    expect(section).toContain("**data**");
    expect(section).toContain("**pdf**");
    // Sorted by name.
    expect(section.indexOf("**data**")).toBeLessThan(
      section.indexOf("**pdf**"),
    );
  });

  it("finds skills nested under category folders", async () => {
    // Spec lets skills live anywhere under a root; we recurse but
    // stop descending once we find SKILL.md so a skill's own scripts/
    // folder isn't mistaken for a sub-skill.
    await writeSkill("docs/pdf", "name: pdf\ndescription: PDFs.");
    await writeSkill("data/csv", "name: csv\ndescription: CSV.");
    const session = new SkillsSession({ roots: [TMP] });
    const section = await session.systemPromptSection();
    expect(section).toContain("**csv**");
    expect(section).toContain("**pdf**");
  });

  it("does not descend into a skill's own subdirectories", async () => {
    // Skill at TMP/wrap with a nested SKILL.md inside scripts/ —
    // should be ignored because we stop at the outer SKILL.md.
    await writeSkill("wrap", "name: wrap\ndescription: outer.");
    const innerDir = path.join(TMP, "wrap", "scripts");
    await fs.mkdir(innerDir, { recursive: true });
    await fs.writeFile(
      path.join(innerDir, "SKILL.md"),
      "---\nname: inner\ndescription: should not be discovered\n---\n",
      "utf8",
    );
    const session = new SkillsSession({ roots: [TMP] });
    const section = await session.systemPromptSection();
    expect(section).toContain("**wrap**");
    expect(section).not.toContain("**inner**");
  });

  it("silently skips missing roots", async () => {
    const session = new SkillsSession({
      roots: [path.join(TMP, "does-not-exist")],
    });
    const section = await session.systemPromptSection();
    expect(section).toBe("");
  });

  it("returns an empty section when no skills are present", async () => {
    const session = new SkillsSession({ roots: [TMP] });
    const section = await session.systemPromptSection();
    expect(section).toBe("");
  });

  it("skips malformed SKILL.md files without crashing", async () => {
    // Missing `description` → throws inside readFrontmatter → swallowed.
    await fs.mkdir(path.join(TMP, "broken"), { recursive: true });
    await fs.writeFile(
      path.join(TMP, "broken", "SKILL.md"),
      "---\nname: broken\n---\nbody\n",
      "utf8",
    );
    await writeSkill("good", "name: good\ndescription: Works.");
    const session = new SkillsSession({ roots: [TMP] });
    const section = await session.systemPromptSection();
    expect(section).toContain("**good**");
    expect(section).not.toContain("**broken**");
  });

  it("rescans on prepareTurn so new skills appear", async () => {
    await writeSkill("a", "name: a\ndescription: First.");
    const session = new SkillsSession({ roots: [TMP] });
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

// ──────────────────────────────────────────────────────────────────────
// trustedPaths and tools.
// ──────────────────────────────────────────────────────────────────────

describe("SkillsSession contributions", () => {
  it("advertises configured roots as read-only trusted paths", async () => {
    const session = new SkillsSession({ roots: [TMP] });
    const trusted = await session.trustedPaths();
    expect(trusted).toHaveLength(1);
    expect(trusted[0]?.path).toBe(TMP);
    expect(trusted[0]?.access).toBe("read");
    expect(trusted[0]?.reason).toMatch(/Agent Skills root/i);
  });

  it("aggregates required-tools across skills, deduped", async () => {
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
    const session = new SkillsSession({ roots: [TMP] });
    const tools = await session.tools();
    expect(tools.map((t) => t.name).sort()).toEqual(["bash", "read_file"]);
    // Session never supplies config — manifest owns that.
    for (const t of tools) expect(t.config).toEqual({});
  });

  it("falls back to default_tools for skills that don't declare", async () => {
    await writeSkill("a", "name: a\ndescription: A.");
    const session = new SkillsSession({ roots: [TMP] });
    const tools = await session.tools();
    expect(tools.map((t) => t.name)).toEqual(["bash"]);
  });

  it("respects an explicit override of default_tools", async () => {
    await writeSkill("a", "name: a\ndescription: A.");
    const session = new SkillsSession({
      roots: [TMP],
      defaultTools: ["read_file"],
    });
    const tools = await session.tools();
    expect(tools.map((t) => t.name)).toEqual(["read_file"]);
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
    const session = new SkillsSession({ roots: [TMP] });
    // text-only contributes nothing; scripted gets the default (bash).
    const tools = await session.tools();
    expect(tools.map((t) => t.name)).toEqual(["bash"]);
  });

  it("default_tools = [] disables registration globally", async () => {
    await writeSkill("a", "name: a\ndescription: A.");
    const session = new SkillsSession({ roots: [TMP], defaultTools: [] });
    const tools = await session.tools();
    expect(tools).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Factory + manifest integration.
// ──────────────────────────────────────────────────────────────────────

describe("skillsSessionFactory", () => {
  it("defaults to ~/.skills when no config is given", async () => {
    const session = skillsSessionFactory.create(
      {},
      {
        manifestDir: TMP,
        agentName: "x",
        loomVersion: "test",
        clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
        storage: TMP,
        metadata: {},
      },
      {},
    );
    const trusted = await Promise.resolve(
      (session as SkillsSession).trustedPaths(),
    );
    expect(trusted[0]?.path).toBe(path.join(os.homedir(), ".skills"));
  });

  it("accepts a single `root`", async () => {
    const session = skillsSessionFactory.create(
      { root: TMP },
      {
        manifestDir: process.cwd(),
        agentName: "x",
        loomVersion: "test",
        clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
        storage: TMP,
        metadata: {},
      },
      {},
    );
    const trusted = await Promise.resolve(
      (session as SkillsSession).trustedPaths(),
    );
    expect(trusted[0]?.path).toBe(TMP);
  });

  it("accepts a `roots` array", async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "loom-skills-2-"));
    try {
      const session = skillsSessionFactory.create(
        { roots: [TMP, other] },
        {
          manifestDir: process.cwd(),
          agentName: "x",
          loomVersion: "test",
          clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
          storage: TMP,
          metadata: {},
        },
        {},
      );
      const trusted = await Promise.resolve(
        (session as SkillsSession).trustedPaths(),
      );
      expect(trusted.map((t) => t.path)).toEqual([TMP, other]);
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it("rejects malformed default_tools", () => {
    expect(() =>
      skillsSessionFactory.create(
        { default_tools: "bash" },
        {
          manifestDir: TMP,
          agentName: "x",
          loomVersion: "test",
          clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
          storage: TMP,
          metadata: {},
        },
        {},
      ),
    ).toThrow(/default_tools/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end: the session contributes to runAgent's tool table.
// ──────────────────────────────────────────────────────────────────────

describe("Skills session via runAgent", () => {
  it("registers skill-required tools alongside manifest tools", async () => {
    // Two skills: one explicitly asks for edit_file, the other says
    // nothing and so falls back to the session's default_tools (bash).
    // Together with the manifest's read_file, all three should land.
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
    const harness: Harness = {
      async run(rt: Runtime) {
        await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return { stopReason: "end_turn" as const };
      },
    };
    const manifest: AgentManifest = {
      name: "skills-e2e",
      systemPrompt: "x",
      tools: { read_file: "builtin" },
      capabilities: {
        read_file: { paths: ["./"] },
        edit_file: { paths: ["./"] },
        bash: { subprocess: "*", paths: ["./"] },
      },
      session: { provider: "skills", root: TMP, default_tools: ["bash"] },
      harness,
    };
    const agent = await runAgent(manifest);
    try {
      const names = agent.agentState.toolTable.list().map((t) => t.name);
      expect(names).toContain("read_file"); // from manifest
      expect(names).toContain("edit_file"); // from `writer` skill
      expect(names).toContain("bash"); // from `defaulter`'s fallback
    } finally {
      await agent.close();
    }
  });

  it("manifest config wins on tool name conflict", async () => {
    // Skill says it needs `read_file`. Manifest also has `read_file`
    // with a custom config. The manifest's ref must be the one
    // resolved, not the session's empty-config copy.
    await writeSkill(
      "reader",
      [
        "name: reader",
        "description: Reads.",
        "metadata:",
        '  loom.required-tools: "read_file"',
      ].join("\n"),
    );
    const harness: Harness = {
      async run(rt: Runtime) {
        await rt.update({ sessionUpdate: "stop", stopReason: "end_turn" });
        return { stopReason: "end_turn" as const };
      },
    };
    const manifest: AgentManifest = {
      name: "dedup-e2e",
      systemPrompt: "x",
      tools: {
        read_file: { provider: "builtin", custom_marker: "from-manifest" },
      },
      capabilities: { read_file: { paths: ["./"] } },
      session: { provider: "skills", root: TMP, default_tools: [] },
      harness,
    };
    const agent = await runAgent(manifest);
    try {
      // We can only observe through the public API that read_file
      // exists and there's exactly one of it (no double-registration).
      const matches = agent.agentState.toolTable
        .list()
        .filter((t) => t.name === "read_file");
      expect(matches).toHaveLength(1);
    } finally {
      await agent.close();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Audit integration.
// ──────────────────────────────────────────────────────────────────────

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
        bash: { subprocess: "*", paths: ["./"] },
      },
      session: { provider: "skills", root: TMP, default_tools: [] },
      harness: { provider: "test" },
    };
    const tree = await auditAgent(manifest);
    // Both manifest and session tools are in the tree.
    const names = tree.tools.map((t) => t.name).sort();
    expect(names).toEqual(["bash", "read_file"]);
    // Session-introduced tools have a `(session: ...)` origin.
    const bashEntry = tree.tools.find((t) => t.name === "bash");
    expect(bashEntry?.introducedBy).toMatch(/session: skills/);
    // Trusted paths from the session are visible.
    expect(tree.trustedPaths).toHaveLength(1);
    expect(tree.trustedPaths[0]?.path).toBe(TMP);
    expect(tree.trustedPaths[0]?.access).toBe("read");
    // No construction error.
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
