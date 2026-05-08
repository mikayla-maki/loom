/**
 * Load Loom extension packages from npm-installed locations.
 *
 * Contract: a package is a Loom extension if its package.json contains a
 * `loom.extension` field pointing at an entry that exports `register(api)`:
 *
 *   { "name": "mcp-loom-extension",
 *     "loom": { "extension": "./dist/index.js" } }
 *
 * Discovery walks <manifestDir>/node_modules → npm root -g →
 * ~/.loom/extensions. Activation is explicit (an `[extensions]` entry in
 * agent.toml) — extensions run as the runtime trust class.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { LoomError } from "../errors.js";
import type {
  HarnessFactory,
  ProviderFactory,
  SessionFactory,
} from "../types/interfaces.js";

import { registerHarness, registerSession } from "./index.js";

const exec = promisify(execFile);

export interface LoomExtensionApi {
  /** Register a harness or session factory by name. */
  registerHarness(factory: HarnessFactory): void;
  registerSession(factory: SessionFactory): void;
  /**
   * Auto-activate a Provider for the current agent. Pass a
   * `ProviderFactory` (not an already-built instance) so the runtime
   * can resolve the factory's declared secrets at boot and inject them
   * into the provider's `init()` call.
   */
  addProvider(factory: ProviderFactory): void;
  readonly agentName: string;
  readonly manifestDir: string;
  readonly loomVersion: string;
  /** Per-extension config from `[extensions].<name>` in agent.toml. */
  readonly config: Record<string, unknown>;
}

type RegisterFn = (api: LoomExtensionApi) => void | Promise<void>;

export interface LoomExtensionModule {
  register?: RegisterFn;
  default?: RegisterFn | { register?: RegisterFn };
}

export interface ExtensionPackageInfo {
  name: string;
  packageDir: string;
  entryPath: string;
  version?: string;
  description?: string;
}

export interface LoadOptions {
  /** Extra roots tried first (used in tests to point at fixtures). */
  searchPaths?: string[];
  /** Override `npm root -g` lookup. */
  npmGlobalRoot?: string;
  /** Override `~/.loom/extensions`. */
  loomExtensionsDir?: string;
}

export async function locateExtensionPackage(
  name: string,
  loadCtx: { agentManifestDir: string },
  options: LoadOptions = {},
): Promise<ExtensionPackageInfo> {
  const roots = await collectSearchRoots(loadCtx.agentManifestDir, options);
  for (const root of roots) {
    const info = await tryLoadPackageJson(path.join(root, name), name);
    if (info) return info;
  }
  throw new LoomError(
    `Cannot find Loom extension package '${name}'. Searched: ${roots.join(", ")}. ` +
      `Install via 'npm install ${name}' (locally), 'npm install -g ${name}' (globally), ` +
      `or place under ~/.loom/extensions/${name}/.`,
  );
}

export async function loadExtensionPackage(
  name: string,
  config: Record<string, unknown>,
  loadCtx: { agentManifestDir: string; agentName: string; loomVersion: string },
  options: LoadOptions = {},
): Promise<{
  info: ExtensionPackageInfo;
  addedProviderFactories: ProviderFactory[];
}> {
  const info = await locateExtensionPackage(name, loadCtx, options);

  let mod: LoomExtensionModule;
  try {
    mod = (await import(
      pathToFileURL(info.entryPath).href
    )) as LoomExtensionModule;
  } catch (e) {
    throw new LoomError(
      `Failed to import Loom extension '${name}' (${info.entryPath}): ${(e as Error).message}`,
      { cause: e },
    );
  }

  const register = pickRegisterFn(mod);
  if (!register) {
    throw new LoomError(
      `Loom extension '${name}' does not export a register() function (entry: ${info.entryPath})`,
    );
  }

  const addedProviderFactories: ProviderFactory[] = [];
  await register({
    registerHarness,
    registerSession,
    addProvider: (f) => addedProviderFactories.push(f),
    agentName: loadCtx.agentName,
    manifestDir: loadCtx.agentManifestDir,
    loomVersion: loadCtx.loomVersion,
    config,
  });
  return { info, addedProviderFactories };
}

export async function listInstalledExtensions(
  loadCtx: { agentManifestDir?: string } = {},
  options: LoadOptions = {},
): Promise<ExtensionPackageInfo[]> {
  const roots = await collectSearchRoots(
    loadCtx.agentManifestDir ?? process.cwd(),
    options,
  );
  const seen = new Set<string>();
  const out: ExtensionPackageInfo[] = [];

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

function pickRegisterFn(mod: LoomExtensionModule): RegisterFn | undefined {
  if (typeof mod.register === "function") return mod.register;
  const d = mod.default;
  if (typeof d === "function") return d;
  if (d && typeof d.register === "function") return d.register;
  return undefined;
}

async function tryLoadPackageJson(
  packageDir: string,
  fallbackName: string,
): Promise<ExtensionPackageInfo | null> {
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
    loom?: { extension?: string };
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed.loom || typeof parsed.loom.extension !== "string") return null;
  const entryAbs = path.resolve(packageDir, parsed.loom.extension);
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

async function collectSearchRoots(
  agentManifestDir: string,
  options: LoadOptions,
): Promise<string[]> {
  const roots: string[] = [...(options.searchPaths ?? [])];

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
    options.loomExtensionsDir ??
      path.join(
        process.env.LOOM_HOME ?? path.join(os.homedir(), ".loom"),
        "extensions",
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
