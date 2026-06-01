import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as TOML from "toml";

import { SecretError } from "../errors.js";

export interface SecretsStore {
  get(name: string): Promise<string | null>;
}

export class EnvSecretsStore implements SecretsStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  async get(name: string): Promise<string | null> {
    const candidates = [
      name,
      name.toUpperCase(),
      `LOOM_${name.toUpperCase()}`,
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
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = {};
        return;
      }
      throw new SecretError(
        `Failed to read secrets file at ${this.path}: ${(e as Error).message}`,
      );
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
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = {};
        return;
      }
      throw new SecretError(
        `Failed to read secrets file at ${this.path}: ${(e as Error).message}`,
      );
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

export class KeychainSecretsStore implements SecretsStore {
  private readonly enabled: boolean;
  private readonly service: string;
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
        resolve(null);
      }
    });
  });
}

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
