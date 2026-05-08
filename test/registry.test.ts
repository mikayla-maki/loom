import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

import { LocalRegistry } from "../src/registry/registry.js";

describe("LocalRegistry", () => {
  it("install + lookup of an agent (returns agent.toml path)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "loom-reg-agent-"));
    try {
      const reg = new LocalRegistry({ root: home });
      const src = path.join(home, ".src", "demo");
      await fs.mkdir(src, { recursive: true });
      await fs.writeFile(
        path.join(src, "agent.toml"),
        `[agent]\nname = "demo"\n[harness]\nprovider = "test"\n`,
      );
      const dest = await reg.install("agent", src);
      expect(dest).toMatch(/agents\/demo$/);
      const looked = await reg.lookup("agent", "demo");
      expect(looked).toMatch(/agents\/demo\/agent\.toml$/);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("lookup returns null for unknown names", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "loom-reg-miss-"));
    try {
      const reg = new LocalRegistry({ root: home });
      expect(await reg.lookup("agent", "nope")).toBeNull();
      expect(await reg.lookup("tool", "nope")).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
