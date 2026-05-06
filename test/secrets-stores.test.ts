import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  ChainedSecretsStore,
  EnvSecretsStore,
  FileSecretsStore,
  KeychainSecretsStore,
  StaticSecretsStore,
  XDGSecretsStore,
} from "../src/runtime/secrets.js";
import { SecretError } from "../src/errors.js";

describe("XDGSecretsStore", () => {
  it("reads a flat key→value TOML file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-xdg-"));
    try {
      const p = path.join(dir, "secrets.toml");
      await fs.writeFile(
        p,
        `# top-level secrets\nANTHROPIC_API_KEY = "sk-test"\nFOO = "bar"\n`,
      );
      const s = new XDGSecretsStore({ path: p });
      expect(await s.get("ANTHROPIC_API_KEY")).toBe("sk-test");
      expect(await s.get("FOO")).toBe("bar");
      expect(await s.get("MISSING")).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the file is missing (silent)", async () => {
    const s = new XDGSecretsStore({
      path: "/nonexistent/loom/secrets.toml",
    });
    expect(await s.get("ANYTHING")).toBeNull();
  });

  it("throws SecretError on malformed TOML", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-xdg-bad-"));
    try {
      const p = path.join(dir, "secrets.toml");
      await fs.writeFile(p, `[[[ not toml\n`);
      const s = new XDGSecretsStore({ path: p });
      await expect(s.get("X")).rejects.toBeInstanceOf(SecretError);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores non-string TOML values (tables, numbers, arrays)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-xdg-mixed-"));
    try {
      const p = path.join(dir, "secrets.toml");
      await fs.writeFile(
        p,
        `S = "ok"\nN = 42\nA = ["x"]\n[t]\nnested = "v"\n`,
      );
      const s = new XDGSecretsStore({ path: p });
      expect(await s.get("S")).toBe("ok");
      expect(await s.get("N")).toBeNull();
      expect(await s.get("A")).toBeNull();
      expect(await s.get("t")).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("KeychainSecretsStore", () => {
  it("returns null on non-darwin platforms (silent fall-through)", async () => {
    const s = new KeychainSecretsStore({ forcePlatform: "linux" });
    expect(await s.get("ANYTHING")).toBeNull();
  });

  it("uses the injected lookup function on any platform", async () => {
    const calls: string[] = [];
    const s = new KeychainSecretsStore({
      lookup: async (name) => {
        calls.push(name);
        return name === "ANTHROPIC_API_KEY" ? "sk-from-keychain" : null;
      },
      forcePlatform: "linux",
    });
    expect(await s.get("ANTHROPIC_API_KEY")).toBe("sk-from-keychain");
    expect(await s.get("MISSING")).toBeNull();
    expect(calls).toEqual(["ANTHROPIC_API_KEY", "MISSING"]);
  });
});

describe("ChainedSecretsStore default-chain priority", () => {
  /**
   * Wires up the same chain `runAgent` builds (caller → env → XDG →
   * keychain → file) and asserts each tier wins when its predecessors
   * miss.
   */
  it("first hit wins; later tiers don't get queried for the same name", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loom-chain-"));
    try {
      const xdgPath = path.join(dir, "xdg.toml");
      const filePath = path.join(dir, ".loom-secrets");
      await fs.writeFile(xdgPath, `XDG_ONLY = "from-xdg"\nSHARED = "xdg-shared"\n`);
      await fs.writeFile(filePath, `FILE_ONLY=from-file\nSHARED=file-shared\n`);

      let keychainCalls = 0;
      const chain = new ChainedSecretsStore([
        new StaticSecretsStore({ STATIC_ONLY: "from-caller" }),
        new EnvSecretsStore({ ENV_ONLY: "from-env" }),
        new XDGSecretsStore({ path: xdgPath }),
        new KeychainSecretsStore({
          lookup: async (n) => {
            keychainCalls += 1;
            return n === "KEYCHAIN_ONLY" ? "from-keychain" : null;
          },
          forcePlatform: "darwin",
        }),
        new FileSecretsStore(filePath),
      ]);

      expect(await chain.get("STATIC_ONLY")).toBe("from-caller");
      expect(await chain.get("ENV_ONLY")).toBe("from-env");
      expect(await chain.get("XDG_ONLY")).toBe("from-xdg");
      expect(await chain.get("KEYCHAIN_ONLY")).toBe("from-keychain");
      expect(await chain.get("FILE_ONLY")).toBe("from-file");

      // SHARED hits XDG before file: XDG value wins.
      expect(await chain.get("SHARED")).toBe("xdg-shared");

      // STATIC/ENV/XDG hits don't touch the keychain.
      expect(keychainCalls).toBe(2); // KEYCHAIN_ONLY + SHARED-miss
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
