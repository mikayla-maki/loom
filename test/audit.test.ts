import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  AuditError,
  auditAgent,
  formatCapabilityTree,
  summariseAuditHealth,
} from "../src/audit/audit.js";
import type { AgentManifest } from "../src/types/manifest.js";
import { useTmpDir, withTmpDir } from "./helpers/tmp.js";

const FIXTURES = path.resolve("test/fixtures");

describe("auditAgent", () => {
  const tmp = useTmpDir("loom-audit-");

  async function writeManifest(body: string): Promise<string> {
    const p = path.join(tmp(), "agent.toml");
    await fs.writeFile(p, body, "utf8");
    return p;
  }

  it("produces a static capability tree for the sample agent", async () => {
    const tree = await auditAgent(
      path.join(FIXTURES, "sample-agent/agent.toml"),
    );
    expect(tree.name).toBe("sample-agent");
    expect(tree.tools.map((t) => t.name).sort()).toEqual([
      "edit_file",
      "find",
      "read_file",
      "write_file",
    ]);
    const readEntry = tree.tools.find((t) => t.name === "read_file");
    expect(readEntry?.optional).toContain("paths");
    expect(readEntry?.requires).toEqual([]);
    expect(readEntry?.granted).toEqual({ paths: ["./"] });
    expect(readEntry?.missing).toEqual([]);
    expect(tree.grants.read_file).toEqual({ paths: ["./"] });
    expect(tree.secretAllowlist).toEqual(["sample_user_name"]);

    const printed = formatCapabilityTree(tree, { color: false });
    expect(printed).toContain("sample-agent");
    expect(printed).toContain("read_file");
    expect(printed).toContain("edit_file");
    expect(printed).toMatch(/read_file\s+via\s+builtin/);
  });

  it("surfaces tool.audit() findings (bash sandbox availability)", async () => {
    const spec: AgentManifest = {
      name: "audit-bash",
      systemPrompt: "x",
      tools: { bash: "builtin" },
      harness: { provider: "test" },
      capabilities: { bash: { commands: "*", paths: ["./"] } },
    };
    const tree = await auditAgent(spec);
    const bashEntry = tree.tools.find((t) => t.name === "bash");
    expect(bashEntry).toBeDefined();
    expect(bashEntry!.findings.length).toBeGreaterThan(0);
    const messages = bashEntry!.findings.map((f) => f.message).join(" ");
    expect(messages).toMatch(/sandbox|bwrap|sandbox-exec/i);
  });

  it("warns when bash is granted `*` (unsandboxed)", async () => {
    const spec: AgentManifest = {
      name: "audit-bash-star",
      systemPrompt: "x",
      tools: { bash: "builtin" },
      harness: { provider: "test" },
      capabilities: { bash: "*" },
    };
    const tree = await auditAgent(spec);
    const bashEntry = tree.tools.find((t) => t.name === "bash");
    const warning = bashEntry!.findings.find((f) => f.severity === "warning");
    expect(warning).toBeDefined();
    expect(warning!.message).toMatch(/unsandboxed/i);
  });

  it("throws AuditError with the partial tree attached when a source is missing", async () => {
    const manifestPath = await writeManifest(
      [
        "[agent]",
        'name = "missing-src"',
        'system_prompt = "x"',
        "[harness]",
        'provider = "test"',
        "[tools.fancy_tool]",
        'provider = { npm = "@nonexistent/loom-pkg" }',
      ].join("\n"),
    );
    let err: AuditError | undefined;
    try {
      await auditAgent(manifestPath);
    } catch (e) {
      err = e as AuditError;
    }
    expect(err).toBeInstanceOf(AuditError);
    expect(err!.tree.unresolvedSources).toHaveLength(1);
    expect(err!.tree.unresolvedSources[0]?.spec).toBe(
      "npm:@nonexistent/loom-pkg@*",
    );
    expect(err!.tree.unresolvedSources[0]?.reason).toMatch(/Cannot find/);
    expect(err!.tree.unresolvedTools.map((u) => u.name)).toContain(
      "fancy_tool",
    );
    expect(err!.health.unresolvedSources).toBe(1);
    expect(err!.health.unresolvedTools).toBeGreaterThanOrEqual(1);
    const printed = formatCapabilityTree(err!.tree);
    expect(printed.toLowerCase()).toContain("unresolved");
  });

  it("renders each layer of a layered session under one heading", async () => {
    const spec: AgentManifest = {
      name: "audit-layered",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test" },
      session: [
        { provider: "compacting", threshold: 60 },
        { provider: "in-memory" },
      ],
    };
    const tree = await auditAgent(spec);
    expect(tree.sessionLayers).toBeDefined();
    expect(tree.sessionLayers!.map((s) => s.factoryName)).toEqual([
      "compacting",
      "in-memory",
    ]);
    expect(tree.session?.factoryName).toBe("compacting");

    const printed = formatCapabilityTree(tree, { color: false });
    expect(printed).toMatch(/session:\s*2 layers, outer→inner/);
    expect(printed).toContain("[0]");
    expect(printed).toContain("compacting");
    expect(printed).toContain("[1]");
    expect(printed).toContain("in-memory");
  });

  it("renders a length-1 layered session identically to the singleton form", async () => {
    const spec: AgentManifest = {
      name: "audit-singleton",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test" },
      session: { provider: "in-memory" },
    };
    const tree = await auditAgent(spec);
    const printed = formatCapabilityTree(tree, { color: false });
    expect(printed).not.toMatch(/\d+ layers, outer→inner/);
    expect(printed).toMatch(/session:\s*in-memory/);
  });

  it("surfaces per-agent storage on the tree and renders it in the formatter", async () => {
    await withTmpDir("loom-audit-storage-", async (dataHome) => {
      const prev = process.env.LOOM_DATA_HOME;
      process.env.LOOM_DATA_HOME = dataHome;
      try {
        const spec: AgentManifest = {
          name: "audit-storage",
          systemPrompt: "x",
          harness: { provider: "test" },
        };
        const tree = await auditAgent(spec);
        expect(tree.storage.source).toBe("name");
        expect(tree.storage.path).toBe(
          path.join(dataHome, "agents", "audit-storage"),
        );
        const printed = formatCapabilityTree(tree, { color: false });
        expect(printed).toMatch(/storage: .*audit-storage/);
        expect(printed).toContain("(from [agent].name)");

        const tree2 = await auditAgent({
          name: "audit-storage-id",
          systemPrompt: "x",
          storageId: "pinned",
          harness: { provider: "test" },
        });
        expect(tree2.storage.source).toBe("storage_id");
        expect(path.basename(tree2.storage.path)).toBe("pinned");
        const printed2 = formatCapabilityTree(tree2, { color: false });
        expect(printed2).toContain("(from [agent].storage_id)");
      } finally {
        if (prev === undefined) {
          delete process.env.LOOM_DATA_HOME;
        } else {
          process.env.LOOM_DATA_HOME = prev;
        }
      }
    });
  });

  it("summariseAuditHealth: zero problems for a clean manifest", async () => {
    const tree = await auditAgent({
      name: "clean",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test" },
    });
    const h = summariseAuditHealth(tree);
    expect(h.agentName).toBe("clean");
    expect(h.totalProblems).toBe(0);
    expect(h.directProblems).toBe(0);
    expect(h.unresolvedSources).toBe(0);
    expect(h.providerInitErrors).toBe(0);
    expect(h.unresolvedTools).toBe(0);
    expect(h.toolsMissingRequires).toBe(0);
    expect(h.toolAuditErrors).toBe(0);
    expect(h.subagents).toEqual([]);
  });

  it("recursive health: a broken sub-agent makes the parent fail audit", async () => {
    const child: AgentManifest = {
      name: "child",
      manifestPath: "/virtual/child.toml",
      systemPrompt: "x",
      harness: { provider: "test" },
      tools: {
        broken: { provider: { npm: "@nonexistent/loom-pkg" } },
      },
      capabilities: { broken: "*" },
    };
    const parent: AgentManifest = {
      name: "parent",
      manifestPath: "/virtual/parent.toml",
      systemPrompt: "x",
      harness: { provider: "test" },
      tools: {
        spawn_subagent: { provider: "builtin", manifest: child },
      },
      capabilities: { spawn_subagent: "*" },
    };
    let err: AuditError | undefined;
    try {
      await auditAgent(parent);
    } catch (e) {
      err = e as AuditError;
    }
    expect(err).toBeInstanceOf(AuditError);

    expect(err!.health.directProblems).toBe(0);
    expect(err!.health.totalProblems).toBeGreaterThan(0);

    expect(err!.health.subagents).toHaveLength(1);
    const childHealth = err!.health.subagents[0]!;
    expect(childHealth.agentName).toBe("child");
    expect(childHealth.directProblems).toBeGreaterThan(0);
    expect(childHealth.unresolvedSources).toBe(1);

    expect(err!.message).toMatch(/parent → child:/);
    expect(err!.message).not.toMatch(/across \d+ agent/);
  });

  it("recursive health: a broken parent AND a broken child both surface", async () => {
    const child: AgentManifest = {
      name: "child",
      manifestPath: "/virtual/child2.toml",
      systemPrompt: "x",
      harness: { provider: "test" },
      tools: {
        broken_in_child: { provider: { npm: "@nonexistent/in-child" } },
      },
      capabilities: { broken_in_child: "*" },
    };
    const parent: AgentManifest = {
      name: "parent",
      manifestPath: "/virtual/parent2.toml",
      systemPrompt: "x",
      harness: { provider: "test" },
      tools: {
        broken_in_parent: { provider: { npm: "@nonexistent/in-parent" } },
        spawn_subagent: { provider: "builtin", manifest: child },
      },
      capabilities: {
        broken_in_parent: "*",
        spawn_subagent: "*",
      },
    };
    let err: AuditError | undefined;
    try {
      await auditAgent(parent);
    } catch (e) {
      err = e as AuditError;
    }
    expect(err).toBeInstanceOf(AuditError);
    expect(err!.health.directProblems).toBeGreaterThan(0);
    expect(err!.health.subagents[0]!.directProblems).toBeGreaterThan(0);
    expect(err!.message).toMatch(/across 2 agent\(s\)/);
    expect(err!.message).toMatch(/^  parent:/m);
    expect(err!.message).toMatch(/^  parent → child:/m);
  });

  it("recursive health: cycle markers don't count as resolution problems", async () => {
    const recursive: AgentManifest = {
      name: "self-cycle",
      manifestPath: "/virtual/self-cycle.toml",
      systemPrompt: "x",
      tools: {},
      harness: { provider: "test" },
    };
    recursive.tools = {
      spawn_subagent: { provider: "builtin", manifest: recursive },
    };
    recursive.capabilities = { spawn_subagent: "*" };
    const tree = await auditAgent(recursive);
    const h = summariseAuditHealth(tree);
    expect(h.totalProblems).toBe(0);
    const inner = tree.tools.find((t) => t.name === "spawn_subagent")!
      .subagents[0];
    expect(inner!.unresolvedTools).toContainEqual(
      expect.objectContaining({ name: "(cycle)" }),
    );
  });

  it.each([
    {
      label: "unresolved [tools] entry against builtin",
      spec: {
        name: "unresolved-tool",
        systemPrompt: "x",
        harness: { provider: "test" },
        tools: { not_a_tool: "builtin" },
        capabilities: { not_a_tool: "*" },
      } as AgentManifest,
      message: /1 unresolved \[tools\] entr/,
      healthField: "unresolvedTools" as const,
    },
    {
      label: "missing npm source",
      spec: {
        name: "strict-test",
        systemPrompt: "x",
        harness: { provider: "test" },
        tools: { fancy_tool: { provider: { npm: "@nonexistent/loom-pkg" } } },
      } as AgentManifest,
      message: /unresolved source/,
      healthField: "unresolvedSources" as const,
    },
    {
      label: "MCP server init failure",
      spec: {
        name: "bad-mcp",
        systemPrompt: "x",
        harness: { provider: "test" },
        providers: {
          nope: {
            provider: "mcp-server",
            command: process.execPath,
            args: ["/definitely/missing/server.mjs"],
          },
        },
        tools: { x: { provider: "nope" } },
        capabilities: { x: "*" },
      } as AgentManifest,
      message: /not fully resolved.*problem/,
      healthField: "providerInitErrors" as const,
    },
  ])("audit throws on $label", async ({ spec, message, healthField }) => {
    let err: AuditError | undefined;
    try {
      await auditAgent(spec);
    } catch (e) {
      err = e as AuditError;
    }
    expect(err).toBeInstanceOf(AuditError);
    expect(err!.message).toMatch(message);
    expect(err!.health[healthField]).toBeGreaterThanOrEqual(1);
    expect(err!.health.totalProblems).toBeGreaterThan(0);
  });

  it("audit failure lists every problem category, not just the first", async () => {
    const manifestPath = await writeManifest(
      [
        "[agent]",
        'name = "multi-fail"',
        'system_prompt = "x"',
        "[harness]",
        'provider = "test"',
        "[tools.from_missing]",
        'provider = { npm = "@nonexistent/pkg" }',
        "[tools.bogus]",
        'provider = "builtin"',
      ].join("\n"),
    );
    try {
      await auditAgent(manifestPath);
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/unresolved source/);
      expect(msg).toMatch(/unresolved \[tools\] entr/);
    }
  });
});
