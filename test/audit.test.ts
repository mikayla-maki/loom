import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  AuditError,
  auditAgent,
  formatCapabilityTree,
  summariseAuditHealth,
} from "../src/audit/audit.js";
import type { AgentManifest } from "../src/types/manifest.js";

const FIXTURES = path.resolve("test/fixtures");

describe("auditAgent", () => {
  it("produces a static capability tree for the sample agent", async () => {
    const tree = await auditAgent(
      path.join(FIXTURES, "sample-agent/agent.toml"),
    );
    expect(tree.name).toBe("sample-agent");
    expect(tree.tools.map((t) => t.name).sort()).toEqual([
      "find",
      "read_file",
      "write_file",
    ]);
    // FS tools have `optional: ["paths"]` and the fixture grants `paths`.
    const readEntry = tree.tools.find((t) => t.name === "read_file");
    expect(readEntry?.optional).toContain("paths");
    expect(readEntry?.requires).toEqual([]); // no required kinds
    expect(readEntry?.granted).toEqual({ paths: ["./"] });
    expect(readEntry?.missing).toEqual([]);
    // The agent's grant table is exposed under `grants`.
    expect(tree.grants.read_file).toEqual({ paths: ["./"] });
    // [agent].secrets allowlist surfaces in the tree.
    expect(tree.secretAllowlist).toEqual(["sample_user_name"]);

    const printed = formatCapabilityTree(tree);
    expect(printed).toContain("sample-agent");
    expect(printed).toContain("read_file");
    expect(printed).toContain("write_file");
    expect(printed).toContain("capabilities granted");
  });

  it("surfaces tool.audit() findings (bash sandbox availability)", async () => {
    // Inline manifest with bash + a structured grant. Bash's audit()
    // checks for /usr/bin/sandbox-exec and reports a finding either
    // way. We assert that SOME finding shows up in the tree.
    const spec: AgentManifest = {
      name: "audit-bash",
      systemPrompt: "x",
      tools: { bash: "builtin" },
      harness: { provider: "test" },
      capabilities: { bash: { subprocess: "*", paths: ["./"] } },
    };
    const tree = await auditAgent(spec);
    const bashEntry = tree.tools.find((t) => t.name === "bash");
    expect(bashEntry).toBeDefined();
    expect(bashEntry!.findings.length).toBeGreaterThan(0);
    // The finding's message should mention sandbox-exec on macOS
    // or the platform's lack of a backend on Linux/other.
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
    // A manifest that references an npm package that doesn't exist
    // on disk. Audit always validates fully now — there's no lenient
    // mode — but the thrown `AuditError` carries the partial tree so
    // callers can still inspect what DID resolve.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-audit-uns-"));
    try {
      const manifestPath = path.join(dir, "agent.toml");
      await fs.writeFile(
        manifestPath,
        [
          "[agent]",
          'name = "missing-src"',
          'system_prompt = "x"',
          "[harness]",
          'provider = "test"',
          "[tools.fancy_tool]",
          'provider = { npm = "@nonexistent/loom-pkg" }',
        ].join("\n"),
        "utf8",
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
      // health includes both the source AND the tool that depended
      // on it.
      expect(err!.health.unresolvedSources).toBe(1);
      expect(err!.health.unresolvedTools).toBeGreaterThanOrEqual(1);
      // The tree is still renderable — callers (the CLI included)
      // can print it before surfacing the error.
      const printed = formatCapabilityTree(err!.tree);
      expect(printed.toLowerCase()).toContain("unresolved");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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
    // sessionLayers carries one summary per layer, outer-to-inner.
    expect(tree.sessionLayers).toBeDefined();
    expect(tree.sessionLayers!.map((s) => s.factoryName)).toEqual([
      "compacting",
      "in-memory",
    ]);
    // The back-compat single-`session` field describes the outermost layer.
    expect(tree.session?.factoryName).toBe("compacting");

    const printed = formatCapabilityTree(tree, { color: false });
    // Multi-layer session shows the summary line, both layers, and
    // their provider sub-lines.
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
    // No "N layers" header on the singleton path.
    expect(printed).not.toMatch(/\d+ layers, outer→inner/);
    // The session: heading still appears with the provider name.
    expect(printed).toMatch(/session:\s*in-memory/);
  });

  it("surfaces per-agent storage on the tree and renders it in the formatter", async () => {
    const dataHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "loom-audit-storage-"),
    );
    try {
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
    } finally {
      await fs.rm(dataHome, { recursive: true, force: true });
    }
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
    // Parent itself is fine. The spawn_subagent tool declares a
    // sub-agent manifest that names a non-existent npm provider.
    // Audit must walk into the sub-agent, find the failure, and
    // roll it up so the parent's `totalProblems > 0`.
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

    // The parent itself is clean — problems live in the child.
    expect(err!.health.directProblems).toBe(0);
    expect(err!.health.totalProblems).toBeGreaterThan(0);

    // Recursive structure: one sub-agent under parent.spawn_subagent.
    expect(err!.health.subagents).toHaveLength(1);
    const childHealth = err!.health.subagents[0]!;
    expect(childHealth.agentName).toBe("child");
    expect(childHealth.directProblems).toBeGreaterThan(0);
    expect(childHealth.unresolvedSources).toBe(1);

    // Failure message paths the sub-agent so the user sees where
    // the problem lives. The "across N agent(s)" hint only
    // appears when MULTIPLE agents have problems — here only the
    // child does, so the header is the single-agent form.
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
    // Failure message lists both agents.
    expect(err!.message).toMatch(/across 2 agent\(s\)/);
    expect(err!.message).toMatch(/^  parent:/m);
    expect(err!.message).toMatch(/^  parent → child:/m);
  });

  it("recursive health: cycle markers don't count as resolution problems", async () => {
    // A manifest whose spawn_subagent declares itself as the
    // sub-agent. The audit walker plants a `(cycle)` marker; that's
    // a diagnostic, not a real unresolved tool, so health should
    // come back zero.
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
    // No throw: cycle marker is filtered from the unresolved-tool count.
    const tree = await auditAgent(recursive);
    const h = summariseAuditHealth(tree);
    expect(h.totalProblems).toBe(0);
    // The (cycle) marker still lives on the tree for visibility.
    const inner = tree.tools.find((t) => t.name === "spawn_subagent")!
      .subagents[0];
    expect(inner!.unresolvedTools).toContainEqual(
      expect.objectContaining({ name: "(cycle)" }),
    );
  });

  it("audit throws on provider load failures", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "loom-audit-load-fail-"),
    );
    try {
      const manifestPath = path.join(dir, "agent.toml");
      await fs.writeFile(
        manifestPath,
        [
          "[agent]",
          'name = "missing-pkg"',
          'system_prompt = "x"',
          "[harness]",
          'provider = "test"',
          "[tools.something]",
          'provider = { npm = "@nonexistent/pkg" }',
        ].join("\n"),
        "utf8",
      );
      let err: AuditError | undefined;
      try {
        await auditAgent(manifestPath);
      } catch (e) {
        err = e as AuditError;
      }
      expect(err).toBeInstanceOf(AuditError);
      expect(err!.message).toMatch(/unresolved source/);
      expect(err!.health.unresolvedSources).toBe(1);
      expect(err!.health.totalProblems).toBeGreaterThan(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("audit throws on MCP init failures (server can't start)", async () => {
    // The MCP factory loads from the built-in registry (no
    // SourceSpec), so `unresolvedSources` won't fire. The init
    // failure path is what catches a bad config.
    const spec: AgentManifest = {
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
    };
    let err: AuditError | undefined;
    try {
      await auditAgent(spec);
    } catch (e) {
      err = e as AuditError;
    }
    expect(err).toBeInstanceOf(AuditError);
    expect(err!.message).toMatch(/not fully resolved.*problem/);
    // Both init AND unresolved-tool fire (the tool can't resolve
    // through a provider that didn't init).
    expect(err!.health.providerInitErrors).toBeGreaterThanOrEqual(1);
    expect(err!.health.unresolvedTools).toBeGreaterThanOrEqual(1);
  });

  it("audit throws on unresolved [tools] entries", async () => {
    // The native provider doesn't claim `not_a_tool`, so this
    // shows up in `unresolvedTools` even in a fully-loaded
    // manifest.
    const spec: AgentManifest = {
      name: "unresolved-tool",
      systemPrompt: "x",
      harness: { provider: "test" },
      tools: { not_a_tool: "builtin" },
      capabilities: { not_a_tool: "*" },
    };
    await expect(auditAgent(spec)).rejects.toThrow(
      /1 unresolved \[tools\] entr/,
    );
  });

  it("audit failure lists every problem category, not just the first", async () => {
    // Combine: missing source + unresolved tool.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-audit-multi-"));
    try {
      const manifestPath = path.join(dir, "agent.toml");
      await fs.writeFile(
        manifestPath,
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
        "utf8",
      );
      try {
        await auditAgent(manifestPath);
        throw new Error("expected throw");
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toMatch(/unresolved source/);
        expect(msg).toMatch(/unresolved \[tools\] entr/);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("audit throws when any source is unresolved", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-audit-strict-"));
    try {
      const manifestPath = path.join(dir, "agent.toml");
      await fs.writeFile(
        manifestPath,
        [
          "[agent]",
          'name = "strict-test"',
          'system_prompt = "x"',
          "[harness]",
          'provider = "test"',
          "[tools.fancy_tool]",
          'provider = { npm = "@nonexistent/loom-pkg" }',
        ].join("\n"),
        "utf8",
      );
      await expect(auditAgent(manifestPath)).rejects.toThrow(
        /unresolved source/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
