import { describe, expect, it } from "vitest";
import * as path from "node:path";

import { auditAgent, formatCapabilityTree } from "../src/audit/audit.js";

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
});
