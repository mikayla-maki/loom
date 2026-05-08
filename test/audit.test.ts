import { describe, expect, it } from "vitest";
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
      "echo",
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
    // echo got the whole-tool `"*"` grant.
    const echoEntry = tree.tools.find((t) => t.name === "echo");
    expect(echoEntry?.granted).toBe("*");
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
});
