import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { FindTool } from "../src/runtime/builtins/find.js";
import { useTmpDir } from "./helpers/tmp.js";

describe("find canonicalizes symlinks before the grant check", () => {
  const root = useTmpDir("loom-find-");

  it("refuses a symlinked root whose target escapes the granted paths", async () => {
    const grant = path.join(root(), "grant");
    const outside = path.join(root(), "outside");
    await fs.mkdir(grant, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "id_rsa"), "SECRET");

    // A symlink sitting *inside* the granted dir but pointing out of it — the
    // exact escape the other path builtins are hardened against.
    const escape = path.join(grant, "escape");
    await fs.symlink(outside, escape);

    const tool = new FindTool({}, { paths: [grant] });
    const result = await tool.execute(
      { pattern: "**/*", root: escape },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the granted paths/);
    // The out-of-grant filename must never leak into the result.
    expect(result.content).not.toContain("id_rsa");
  });

  it("still lists files within the granted root", async () => {
    const grant = path.join(root(), "grant");
    await fs.mkdir(grant, { recursive: true });
    await fs.writeFile(path.join(grant, "a.ts"), "");
    await fs.writeFile(path.join(grant, "b.md"), "");

    const tool = new FindTool({}, { paths: [grant] });
    const result = await tool.execute(
      { pattern: "*.ts", root: grant },
      {} as never,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("a.ts");
  });
});
