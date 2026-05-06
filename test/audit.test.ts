import { describe, expect, it } from "vitest";
import * as path from "node:path";

import { auditAgent, formatCapabilityTree } from "../src/audit/audit.js";

const FIXTURES = path.resolve("test/fixtures");

describe("auditAgent", () => {
  it("produces a static capability tree for the sample agent", async () => {
    const tree = await auditAgent(path.join(FIXTURES, "sample-agent/agent.toml"));
    expect(tree.name).toBe("sample-agent");
    expect(tree.tools.map((t) => t.name).sort()).toEqual(["greet", "uppercase"]);
    expect(tree.required.secrets).toEqual(["sample_user_name"]);
    expect(tree.subagents).toHaveLength(0);
    const printed = formatCapabilityTree(tree);
    expect(printed).toContain("sample-agent");
    expect(printed).toContain("uppercase");
  });
});
