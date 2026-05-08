/**
 * Secrets store.
 *
 * V0 ships several implementations:
 *  - `EnvSecretsStore`      — looks up upper-cased + LOOM_-prefixed env vars.
 *  - `FileSecretsStore`     — reads a JSON or .env-style file (per-agent
 *                             `.loom-secrets`, used in tests too).
 *  - `XDGSecretsStore`      — reads `$XDG_CONFIG_HOME/loom/secrets.toml`,
 *                             defaulting to `~/.config/loom/secrets.toml`.
 *  - `KeychainSecretsStore` — macOS-only via `security find-generic-password`.
 *                             Returns null on non-macOS hosts (degrade silently).
 *  - `StaticSecretsStore`   — caller-supplied dict, top-priority overlay.
 *
 * The runtime never lets a secret value reach the model — it's only ever
 * passed to a tool process via env vars at execute time, or to a factory's
 * `create()` for harnesses/sessions/providers.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as TOML from "@iarna/toml";

import { SecretError } from "../errors.js";

export interface SecretsStore {
  /** Return the secret value, or null if missing. */
  get(name: string): Promise<string | null>;
}

export class EnvSecretsStore implements SecretsStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  async get(name: string): Promise<string | null> {
    // Try multiple aliasings: exact, upper, LOOM_ prefixed.
    const candidates = [
      name,
      name.toUpperCase(),
      `LOOM_${name.toUpperCase()}`,
      // also dot.case → DOT_CASE
      name.replace(/[.\-]/g, "_").toUpperCase(),
      `LOOM_${name.replace(/[.\-]/g, "_").toUpperCase()}`,
    ];
    for (const c of candidates) {
      const v = this.env[c];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return null;
  }
}

export class StaticSecretsStore implements SecretsStore {
  constructor(private readonly data: Record<string, string>) {}
  async get(name: string): Promise<string | null> {
    return this.data[name] ?? null;
  }
}

export class FileSecretsStore implements SecretsStore {
  private cache: Record<string, string> | null = null;
  constructor(private readonly path: string) {}

  async get(name: string): Promise<string | null> {
    if (!this.cache) await this.load();
    return (this.cache && this.cache[name]) ?? null;
  }

  private async load(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.path, "utf8");
    } catch {
      this.cache = {};
      return;
    }
    text = text.trim();
    if (text.startsWith("{")) {
      try {
        this.cache = JSON.parse(text) as Record<string, string>;
      } catch (e) {
        throw new SecretError(
          `Failed to parse secrets JSON at ${this.path}: ${(e as Error).message}`,
        );
      }
    } else {
      // .env style
      const out: Record<string, string> = {};
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const k = trimmed.slice(0, eq).trim();
        let v = trimmed.slice(eq + 1).trim();
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1);
        }
        out[k] = v;
      }
      this.cache = out;
    }
  }
}

/**
 * Reads `$XDG_CONFIG_HOME/loom/secrets.toml` (fallback `~/.config/loom/secrets.toml`).
 * The TOML file is a flat key→value map. Missing file is silent (returns null).
 *
 * The path can be overridden via the constructor for tests.
 */
export class XDGSecretsStore implements SecretsStore {
  private cache: Record<string, string> | null = null;
  private readonly path: string;

  constructor(opts: { path?: string } = {}) {
    this.path = opts.path ?? defaultXdgSecretsPath();
  }

  async get(name: string): Promise<string | null> {
    if (!this.cache) await this.load();
    return (this.cache && this.cache[name]) ?? null;
  }

  private async load(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.path, "utf8");
    } catch {
      this.cache = {};
      return;
    }
    let parsed: unknown;
    try {
      parsed = TOML.parse(text);
    } catch (e) {
      throw new SecretError(
        `Failed to parse secrets TOML at ${this.path}: ${(e as Error).message}`,
      );
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    this.cache = out;
  }
}

function defaultXdgSecretsPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "loom", "secrets.toml");
}

/**
 * macOS Keychain reader. Each lookup runs:
 *   security find-generic-password -s loom -a <name> -w
 *
 * The `-s loom` service scopes Loom secrets to a single keychain item set;
 * the user can populate it with:
 *   security add-generic-password -s loom -a ANTHROPIC_API_KEY -w sk-ant-...
 *
 * On non-macOS hosts the constructor records `enabled = false` and `get()`
 * returns null without ever spawning. We don't surface an error — the
 * default chain falls through to the file/env stores.
 */
export class KeychainSecretsStore implements SecretsStore {
  private readonly enabled: boolean;
  private readonly service: string;
  /**
   * Test-only override: when set, replaces the spawn() call. Resolves to
   * the secret value (or null for "not found"); rejects to bubble an
   * unexpected failure.
   */
  private readonly lookup:
    | ((name: string) => Promise<string | null>)
    | undefined;

  constructor(
    opts: {
      service?: string;
      lookup?: (name: string) => Promise<string | null>;
      forcePlatform?: NodeJS.Platform;
    } = {},
  ) {
    const platform = opts.forcePlatform ?? process.platform;
    this.enabled = platform === "darwin" || opts.lookup !== undefined;
    this.service = opts.service ?? "loom";
    this.lookup = opts.lookup;
  }

  async get(name: string): Promise<string | null> {
    if (!this.enabled) return null;
    if (this.lookup) return await this.lookup(name);
    return await runKeychainLookup(this.service, name);
  }
}

async function runKeychainLookup(
  service: string,
  account: string,
): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const child = spawn(
      "security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code === 0) {
        const trimmed = stdout.replace(/\n$/, "");
        resolve(trimmed.length > 0 ? trimmed : null);
      } else {
        // Exit 44 = item not found on macOS; any non-zero is treated as miss.
        resolve(null);
      }
    });
  });
}

/** Try a list of stores in order; first hit wins. */
export class ChainedSecretsStore implements SecretsStore {
  constructor(private readonly stores: SecretsStore[]) {}
  async get(name: string): Promise<string | null> {
    for (const s of this.stores) {
      const v = await s.get(name);
      if (v !== null) return v;
    }
    return null;
  }
}

/**
 * Resolve all required secrets at agent boot time. Throws if any missing
 * (unless allowMissing is true, in which case missing become undefined).
 */
export async function resolveSecrets(
  store: SecretsStore,
  required: Iterable<string>,
  options: { allowMissing?: boolean } = {},
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of required) {
    const v = await store.get(name);
    if (v === null) {
      if (options.allowMissing) continue;
      missing.push(name);
    } else {
      out[name] = v;
    }
  }
  if (missing.length > 0) {
    throw new SecretError(
      `Required secrets missing: ${missing.join(", ")}. Set them via environment, a secrets file, or a custom SecretsStore.`,
    );
  }
  return out;
}
