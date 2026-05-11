import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { auditAgent, formatCapabilityTree } from "../src/audit/audit.js";
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

  it("records unresolved sources without throwing in default mode", async () => {
    // A manifest that references an npm package that doesn't exist on
    // disk. Default audit keeps going and records the gap; the tool
    // also shows up as unresolved because no provider claimed it.
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
      const tree = await auditAgent(manifestPath);
      expect(tree.unresolvedSources).toHaveLength(1);
      expect(tree.unresolvedSources[0]?.spec).toBe(
        "npm:@nonexistent/loom-pkg@*",
      );
      expect(tree.unresolvedSources[0]?.reason).toMatch(/Cannot find/);
      // The tool itself is also unresolved because its source didn't
      // load.
      expect(tree.unresolvedTools.map((u) => u.name)).toContain("fancy_tool");
      // formatCapabilityTree should mention the unresolved source.
      const printed = formatCapabilityTree(tree);
      expect(printed.toLowerCase()).toContain("unresolved");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("--strict throws when any source is unresolved", async () => {
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
      await expect(auditAgent(manifestPath, { strict: true })).rejects.toThrow(
        /unresolved source/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
