import { describe, expect, it } from "vitest";
import * as path from "node:path";

import { auditAgent, formatCapabilityTree } from "../src/audit/audit.js";

const FIXTURES = path.resolve("test/fixtures");

describe("auditAgent", () => {
  it("produces a static capability tree for the sample agent", async () => {
    // The new sample-agent fixture has no skills — just the default
    // builtin tool set, configured for the project root.
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
    // read_file/write_file/find expose `{ paths: [...] }` capabilities.
    const readEntry = tree.tools.find((t) => t.name === "read_file");
    expect(readEntry?.capabilities).toMatchObject({ paths: expect.any(Array) });
    expect(
      Array.isArray((readEntry?.capabilities as { paths?: unknown }).paths),
    ).toBe(true);
    // The sample agent declares its sandbox ceiling per-tool.
    expect(tree.ceiling.read_file).toBeDefined();

    const printed = formatCapabilityTree(tree);
    expect(printed).toContain("sample-agent");
    expect(printed).toContain("read_file");
    expect(printed).toContain("write_file");
  });
});
