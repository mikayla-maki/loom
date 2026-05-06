/**
 * Secrets store.
 *
 * V0 ships two implementations:
 *  - EnvSecretsStore — looks up upper-cased + LOOM_-prefixed env vars.
 *  - FileSecretsStore — reads a JSON or .env-style file (used in tests).
 *
 * The runtime never lets a secret value reach the model — it's only ever
 * passed to a tool process via env vars at execute time.
 */

import * as fs from "node:fs/promises";

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
        throw new SecretError(`Failed to parse secrets JSON at ${this.path}: ${(e as Error).message}`);
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
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        out[k] = v;
      }
      this.cache = out;
    }
  }
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
