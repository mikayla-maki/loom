/**
 * Loom provider loader — locates and loads provider packages from disk.
 *
 * A Loom provider is an npm-shaped package whose `package.json` has a
 * `loom.provider` field pointing at an entry that exports
 * `register(api)`. The entry, when imported, registers harness,
 * session, and Tools contributions against the host runtime via the
 * `LoomProviderApi` it receives.
 *
 * Discovery walks: `<manifestDir>/.loom/node_modules` → ancestor
 * `node_modules` → `npm root -g` → `~/.loom/providers`. Activation is
 * explicit — the runtime only loads packages referenced from
 * `[providers]`, `[tools]`, `[harness]`, or `[session]` in the
 * manifest. There is no global side-effect registration.
 *
 * v5 unifies the registration shape: `registerTools`,
 * `registerHarness`, and `registerSession` all take a
 * `ContributionRegistration<T>` and produce a `T`. The provider
 * decides how many of each kind to contribute; the runtime calls
 * `create(config, ctx, secrets, parent?)` once per instance the
 * manifest asks for.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { LoomError } from "../errors.js";
import { expandHome } from "../internal/util.js";
import type {
  Agent,
  FactoryContext,
  Harness,
  HarnessFactory,
  SecretNeeds,
  Session,
  SessionFactory,
  Tools,
} from "../types/interfaces.js";
import type { JSONSchema } from "../types/schema.js";
import type { SourceSpec } from "../types/manifest.js";

import { registerHarness, registerSession } from "../builtins/index.js";

const exec = promisify(execFile);

/**
 * One contribution a provider's `register()` declares. Used uniformly
 * across `registerTools`, `registerHarness`, and `registerSession`;
 * what differs is the type the factory returns from `create()`.
 *
 * Convention: a provider's *primary* contribution of each kind is
 * registered under its package name. That's what makes
 * `provider = "<handle>"` work without the provider author knowing
 * what handle the manifest used — the runtime falls back to the
 * package name when the handle lookup misses.
 */
export interface ContributionRegistration<T> {
  /** Name the manifest references via `provider = "<this>"`. */
  readonly name: string;
  /** Secret names this contribution wants. Resolved before `create` runs. */
  readonly secrets?: SecretNeeds;
  /**
   * Per-INSTANCE secret-need callback. Some factories (notably the
   * built-in `mcp-server`) can only know which secrets they need by
   * inspecting the user's instance config. Implement this when the
   * static `secrets` field can't cover it; the runtime merges the
   * returned needs into Phase 1 of secret loading and passes the
   * resolved values to `create()` alongside the static set.
   *
   * Return `undefined` when this instance needs no extra secrets.
   */
  instanceSecretNeeds?(
    config: Record<string, unknown>,
  ): SecretNeeds | undefined;
  /** Optional JSON schema for the contribution's per-instance config. */
  readonly configSchema?: JSONSchema;
  /**
   * Sessions / harnesses that need a parent agent set this. Ignored
   * for tools (the manifest can't address a Tools contribution from a
   * sub-agent slot). Enforced at boot.
   */
  readonly requiresParent?: boolean;
  /**
   * Construct the contribution. Called once per instance the manifest
   * asks for; the runtime dedupes anonymous Tools instances by
   * `(source, config)` so multiple references with the same config
   * share one `T`.
   */
  create(
    config: Record<string, unknown>,
    ctx: FactoryContext,
    secrets: Record<string, string>,
    parent?: Agent,
  ): T | Promise<T>;
}

/**
 * The API a provider's `register()` function sees. The three
 * `register<X>` methods accept the same `ContributionRegistration<T>`
 * shape; what differs is `T`.
 */
export interface LoomProviderApi {
  registerTools(reg: ContributionRegistration<Tools>): void;
  registerHarness(reg: ContributionRegistration<Harness>): void;
  registerSession(reg: ContributionRegistration<Session>): void;

  /**
   * This provider's handle from `[providers]`, or its package name
   * when referenced inline.
   */
  readonly providerName: string;
  readonly agentName: string;
  readonly manifestDir: string;
  readonly loomVersion: string;
}

type RegisterFn = (api: LoomProviderApi) => void | Promise<void>;

export interface LoomProviderModule {
  register?: RegisterFn;
  default?: RegisterFn | { register?: RegisterFn };
}

export interface ProviderPackageInfo {
  /** Package name from `package.json` (or fallback to dir basename). */
  name: string;
  packageDir: string;
  /** Absolute path to the registered entry file. */
  entryPath: string;
  version?: string;
  description?: string;
}

export interface LoadOptions {
  /** Extra roots tried first (used in tests to point at fixtures). */
  searchPaths?: string[];
  /** Override `npm root -g` lookup. */
  npmGlobalRoot?: string;
  /** Override `~/.loom/providers`. */
  loomProvidersDir?: string;
}

/**
 * Result of loading one provider: its metadata plus the contributions
 * its `register()` produced. Harness and session contributions are
 * deposited as `HarnessFactory` / `SessionFactory` shapes into the
 * global registries during load; Tools contributions are returned to
 * the caller so the runtime can instantiate them per the manifest's
 * `(source, config)` dedup.
 */
export interface LoadedProvider {
  info: ProviderPackageInfo;
  /**
   * Tools contributions this provider declared (zero or more). Each
   * has a `name` (defaulted to the package name when the provider
   * omits it) and `create(config, ctx, secrets, parent?) → Tools`.
   */
  toolsContributions: ContributionRegistration<Tools>[];
}

// ─── Locate / load by npm name ────────────────────────────────────────────

export async function locateProviderPackage(
  name: string,
  loadCtx: { agentManifestDir: string },
  options: LoadOptions = {},
): Promise<ProviderPackageInfo> {
  const roots = await collectSearchRoots(loadCtx.agentManifestDir, options);
  for (const root of roots) {
    const info = await tryLoadPackageJson(path.join(root, name), name);
    if (info) return info;
  }
  throw new LoomError(
    `Cannot find Loom provider package '${name}'. Searched: ${roots.join(", ")}. ` +
      `Install via 'npm install ${name}' (locally), 'npm install -g ${name}' (globally), ` +
      `or place under ~/.loom/providers/${name}/.`,
  );
}

export async function loadProviderByName(
  name: string,
  loadCtx: {
    agentManifestDir: string;
    agentName: string;
    loomVersion: string;
    providerName: string;
  },
  options: LoadOptions = {},
): Promise<LoadedProvider> {
  const info = await locateProviderPackage(name, loadCtx, options);
  return loadProviderFromInfo(info, loadCtx);
}

/**
 * Load a provider from an absolute path (used for `{ path = "..." }`
 * SourceSpecs). Skips the `node_modules` search; still requires a
 * `package.json` with a `loom.provider` entry.
 */
export async function loadProviderFromPath(
  absPath: string,
  loadCtx: {
    agentManifestDir: string;
    agentName: string;
    loomVersion: string;
    providerName: string;
  },
): Promise<LoadedProvider> {
  const info = await tryLoadPackageJson(absPath, path.basename(absPath));
  if (!info) {
    throw new LoomError(
      `Path source '${absPath}' does not look like a Loom provider package ` +
        `(no package.json with \`loom.provider\` pointing at a JS entry).`,
    );
  }
  return loadProviderFromInfo(info, loadCtx);
}

/**
 * Dispatch a `SourceSpec` to the right loader. "builtin" isn't a
 * SourceSpec — built-in factories are looked up via registries by
 * bare-handle name, not loaded from disk — so this function never
 * returns null.
 */
export async function loadProviderFromSource(
  source: SourceSpec,
  loadCtx: {
    agentManifestDir: string;
    agentName: string;
    loomVersion: string;
    providerName: string;
  },
  options: LoadOptions = {},
): Promise<LoadedProvider> {
  if ("npm" in source) {
    return loadProviderByName(source.npm, loadCtx, options);
  }
  if ("path" in source) {
    // `expandHome` first so `~/loom-providers/foo` resolves to the
    // user's home dir instead of `<manifestDir>/~/loom-providers/foo`.
    const expanded = expandHome(source.path);
    const abs = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(loadCtx.agentManifestDir, expanded);
    return loadProviderFromPath(abs, loadCtx);
  }
  throw new LoomError(`Unknown SourceSpec shape: ${JSON.stringify(source)}`);
}

// ─── Common load path ────────────────────────────────────────────────────

async function loadProviderFromInfo(
  info: ProviderPackageInfo,
  loadCtx: {
    agentManifestDir: string;
    agentName: string;
    loomVersion: string;
    providerName: string;
  },
): Promise<LoadedProvider> {
  let mod: LoomProviderModule;
  try {
    mod = (await import(
      pathToFileURL(info.entryPath).href
    )) as LoomProviderModule;
  } catch (e) {
    throw new LoomError(
      `Failed to import Loom provider '${info.name}' (${info.entryPath}): ${(e as Error).message}`,
      { cause: e },
    );
  }

  const register = pickRegisterFn(mod);
  if (!register) {
    throw new LoomError(
      `Loom provider '${info.name}' does not export a register() function (entry: ${info.entryPath})`,
    );
  }

  const toolsContributions: ContributionRegistration<Tools>[] = [];
  await register({
    registerTools: (reg) => toolsContributions.push(reg),
    registerHarness: (reg) => registerHarness(toHarnessFactory(reg)),
    registerSession: (reg) => registerSession(toSessionFactory(reg)),
    providerName: loadCtx.providerName,
    agentName: loadCtx.agentName,
    manifestDir: loadCtx.agentManifestDir,
    loomVersion: loadCtx.loomVersion,
  });
  return { info, toolsContributions };
}

/**
 * Adapt a `ContributionRegistration<Harness>` to the `HarnessFactory`
 * shape consumed by the global registry. The shapes differ only in
 * vocabulary (`secrets`, `requiresParent`, `create` are identical);
 * the registry sees the same interface either way.
 */
function toHarnessFactory(
  reg: ContributionRegistration<Harness>,
): HarnessFactory {
  return {
    name: reg.name,
    ...(reg.secrets ? { secrets: reg.secrets } : {}),
    ...(reg.requiresParent ? { requiresParent: reg.requiresParent } : {}),
    create: (config, ctx, secrets, parent) =>
      reg.create(config, ctx, secrets, parent),
  };
}

function toSessionFactory(
  reg: ContributionRegistration<Session>,
): SessionFactory {
  return {
    name: reg.name,
    ...(reg.secrets ? { secrets: reg.secrets } : {}),
    ...(reg.requiresParent ? { requiresParent: reg.requiresParent } : {}),
    create: (config, ctx, secrets, parent) =>
      reg.create(config, ctx, secrets, parent),
  };
}

// ─── Listing (introspection) ──────────────────────────────────────────────

/**
 * Enumerate every Loom provider discoverable from a base directory.
 * Used by `loom providers list` (and future audit affordances). The
 * search walks the same roots `loadProviderByName` uses; resolution
 * winner is the *first* hit.
 */
export async function listInstalledProviders(
  loadCtx: { agentManifestDir?: string } = {},
  options: LoadOptions = {},
): Promise<ProviderPackageInfo[]> {
  const roots = await collectSearchRoots(
    loadCtx.agentManifestDir ?? process.cwd(),
    options,
  );
  const seen = new Set<string>();
  const out: ProviderPackageInfo[] = [];

  for (const root of roots) {
    for (const fullName of await listPackageNames(root)) {
      if (seen.has(fullName)) continue;
      const dir = path.join(root, fullName);
      const info = await tryLoadPackageJson(dir, fullName);
      if (info) {
        seen.add(fullName);
        out.push(info);
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function listPackageNames(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.startsWith("@")) {
      out.push(e);
      continue;
    }
    let inner: string[];
    try {
      inner = await fs.readdir(path.join(root, e));
    } catch {
      continue;
    }
    for (const sub of inner) out.push(`${e}/${sub}`);
  }
  return out;
}

// ─── package.json introspection ──────────────────────────────────────────

function pickRegisterFn(mod: LoomProviderModule): RegisterFn | undefined {
  if (typeof mod.register === "function") return mod.register;
  const d = mod.default;
  if (typeof d === "function") return d;
  if (d && typeof d.register === "function") return d.register;
  return undefined;
}

async function tryLoadPackageJson(
  packageDir: string,
  fallbackName: string,
): Promise<ProviderPackageInfo | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(packageDir, "package.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: {
    name?: string;
    version?: string;
    description?: string;
    loom?: { provider?: string };
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed.loom || typeof parsed.loom.provider !== "string") return null;
  const entryAbs = path.resolve(packageDir, parsed.loom.provider);
  try {
    await fs.access(entryAbs);
  } catch {
    return null;
  }
  return {
    name: parsed.name ?? fallbackName,
    packageDir,
    entryPath: entryAbs,
    ...(parsed.version ? { version: parsed.version } : {}),
    ...(parsed.description ? { description: parsed.description } : {}),
  };
}

// ─── Search-root assembly ────────────────────────────────────────────────

async function collectSearchRoots(
  agentManifestDir: string,
  options: LoadOptions,
): Promise<string[]> {
  const roots: string[] = [...(options.searchPaths ?? [])];

  // `loom install` writes into <manifest-dir>/.loom/node_modules/,
  // isolated from the user's own package.json. Check there first so
  // loom-installed packages take precedence over the surrounding tree.
  roots.push(path.join(agentManifestDir, ".loom", "node_modules"));

  // Walk up node_modules (mirrors Node's resolver, capped at 8 levels).
  let dir = agentManifestDir;
  roots.push(path.join(dir, "node_modules"));
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    roots.push(path.join(dir, "node_modules"));
  }

  const globalRoot = options.npmGlobalRoot ?? (await getNpmGlobalRoot());
  if (globalRoot) roots.push(globalRoot);

  roots.push(
    options.loomProvidersDir ??
      path.join(
        process.env.LOOM_HOME ?? path.join(os.homedir(), ".loom"),
        "providers",
      ),
  );

  return [...new Set(roots.filter(Boolean))];
}

async function getNpmGlobalRoot(): Promise<string | null> {
  try {
    const { stdout } = await exec("npm", ["root", "-g"], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
