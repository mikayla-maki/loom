import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  ChainedSecretsStore,
  EnvSecretsStore,
  FileSecretsStore,
  KeychainSecretsStore,
  StaticSecretsStore,
  XDGSecretsStore,
} from "../src/runtime/secrets.js";
import { buildSecretStore } from "../src/sdk/run-agent.js";
import type { AgentManifest } from "../src/types/manifest.js";
import { SecretError } from "../src/errors.js";
import { useTmpDir } from "./helpers/tmp.js";

describe("XDGSecretsStore", () => {
  const tmp = useTmpDir("loom-xdg-");

  it("reads string values and ignores non-strings, missing keys, and missing files", async () => {
    const p = path.join(tmp(), "secrets.toml");
    await fs.writeFile(
      p,
      `ANTHROPIC_API_KEY = "sk-test"\nFOO = "bar"\nN = 42\nA = ["x"]\n[t]\nnested = "v"\n`,
    );
    const s = new XDGSecretsStore({ path: p });
    expect(await s.get("ANTHROPIC_API_KEY")).toBe("sk-test");
    expect(await s.get("FOO")).toBe("bar");
    expect(await s.get("N")).toBeNull();
    expect(await s.get("A")).toBeNull();
    expect(await s.get("t")).toBeNull();
    expect(await s.get("MISSING")).toBeNull();

    const missing = new XDGSecretsStore({
      path: "/nonexistent/loom/secrets.toml",
    });
    expect(await missing.get("ANYTHING")).toBeNull();
  });

  it("throws SecretError on malformed TOML", async () => {
    const p = path.join(tmp(), "secrets.toml");
    await fs.writeFile(p, `[[[ not toml\n`);
    const s = new XDGSecretsStore({ path: p });
    await expect(s.get("X")).rejects.toBeInstanceOf(SecretError);
  });
});

describe("KeychainSecretsStore", () => {
  it("returns null on non-darwin platforms without invoking lookup", async () => {
    const s = new KeychainSecretsStore({ forcePlatform: "linux" });
    expect(await s.get("ANYTHING")).toBeNull();
  });

  it("uses the injected lookup function", async () => {
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
  const tmp = useTmpDir("loom-chain-");

  it("first hit wins and later tiers aren't queried for the same name", async () => {
    const xdgPath = path.join(tmp(), "xdg.toml");
    const filePath = path.join(tmp(), ".loom-secrets");
    await fs.writeFile(
      xdgPath,
      `XDG_ONLY = "from-xdg"\nSHARED = "xdg-shared"\n`,
    );
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
    expect(await chain.get("SHARED")).toBe("xdg-shared");

    expect(keychainCalls).toBe(2);
  });
});

describe("buildSecretStore precedence (dotenv-style: local file wins)", () => {
  const tmp = useTmpDir("loom-buildsecrets-");

  it("a manifest-dir .loom-secrets overrides an env var of the same name", async () => {
    const manifestDir = tmp();
    await fs.writeFile(
      path.join(manifestDir, ".loom-secrets"),
      `LOOM_TEST_SHARED=from-manifest-file\nLOOM_TEST_FILE_ONLY=file-only\n`,
    );
    const manifest = {
      name: "t",
      harness: { provider: "test" },
      manifestPath: path.join(manifestDir, "agent.toml"),
    } as AgentManifest;

    const prevShared = process.env.LOOM_TEST_SHARED;
    const prevEnvOnly = process.env.LOOM_TEST_ENV_ONLY;
    process.env.LOOM_TEST_SHARED = "from-env";
    process.env.LOOM_TEST_ENV_ONLY = "env-only";
    try {
      const store = buildSecretStore(manifest, {});
      // Local file beats env for a name they share — the whole point of the
      // dotenv-style ordering.
      expect(await store.get("LOOM_TEST_SHARED")).toBe("from-manifest-file");
      // File-only name resolves from the file.
      expect(await store.get("LOOM_TEST_FILE_ONLY")).toBe("file-only");
      // A name absent from the local files still falls through to env.
      expect(await store.get("LOOM_TEST_ENV_ONLY")).toBe("env-only");
    } finally {
      if (prevShared === undefined) delete process.env.LOOM_TEST_SHARED;
      else process.env.LOOM_TEST_SHARED = prevShared;
      if (prevEnvOnly === undefined) delete process.env.LOOM_TEST_ENV_ONLY;
      else process.env.LOOM_TEST_ENV_ONLY = prevEnvOnly;
    }
  });
});
