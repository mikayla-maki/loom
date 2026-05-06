/**
 * Load Glass extension packages from npm-installed locations.
 *
 * Contract: a package is a Glass extension if its package.json contains a
 * `glass.extension` field pointing at an entry that exports `register(api)`:
 *
 *   { "name": "mcp-glass-extension",
 *     "glass": { "extension": "./dist/index.js" } }
 *
 * Discovery walks <manifestDir>/node_modules → npm root -g →
 * ~/.glass/extensions. Activation is explicit (an `[extensions]` entry in
 * agent.toml) — extensions run as the runtime trust class.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { GlassError } from "../errors.js";
import type {
  HarnessFactory,
  Provider,
  ProviderFactory,
  SessionFactory,
} from "../types/interfaces.js";

import { registerHarness, registerProvider, registerSession } from "./index.js";

const exec = promisify(execFile);

export interface GlassExtensionApi {
  /** Register a factory by name; the user activates it via the matching manifest table. */
  registerHarness(factory: HarnessFactory): void;
  registerSession(factory: SessionFactory): void;
  registerProvider(factory: ProviderFactory): void;
  /**
   * Auto-activate a Provider instance for the current agent. Common case
   * for "list this extension and you get its tools" — no [providers] entry
   * required.
   */
  addProvider(provider: Provider): void;
  readonly agentName: string;
  readonly manifestDir: string;
  readonly glassVersion: string;
  /** Per-extension config from `[extensions].<name>` in agent.toml. */
  readonly config: Record<string, unknown>;
}

type RegisterFn = (api: GlassExtensionApi) => void | Promise<void>;

export interface GlassExtensionModule {
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
  /** Override `~/.glass/extensions`. */
  glassExtensionsDir?: string;
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
  throw new GlassError(
    `Cannot find Glass extension package '${name}'. Searched: ${roots.join(", ")}. ` +
      `Install via 'npm install ${name}' (locally), 'npm install -g ${name}' (globally), ` +
      `or place under ~/.glass/extensions/${name}/.`,
  );
}

export async function loadExtensionPackage(
  name: string,
  config: Record<string, unknown>,
  loadCtx: { agentManifestDir: string; agentName: string; glassVersion: string },
  options: LoadOptions = {},
): Promise<{ info: ExtensionPackageInfo; addedProviders: Provider[] }> {
  const info = await locateExtensionPackage(name, loadCtx, options);

  let mod: GlassExtensionModule;
  try {
    mod = (await import(pathToFileURL(info.entryPath).href)) as GlassExtensionModule;
  } catch (e) {
    throw new GlassError(
      `Failed to import Glass extension '${name}' (${info.entryPath}): ${(e as Error).message}`,
      { cause: e },
    );
  }

  const register = pickRegisterFn(mod);
  if (!register) {
    throw new GlassError(
      `Glass extension '${name}' does not export a register() function (entry: ${info.entryPath})`,
    );
  }

  const addedProviders: Provider[] = [];
  await register({
    registerHarness,
    registerSession,
    registerProvider,
    addProvider: (p) => addedProviders.push(p),
    agentName: loadCtx.agentName,
    manifestDir: loadCtx.agentManifestDir,
    glassVersion: loadCtx.glassVersion,
    config,
  });
  return { info, addedProviders };
}

export async function listInstalledExtensions(
  loadCtx: { agentManifestDir?: string } = {},
  options: LoadOptions = {},
): Promise<ExtensionPackageInfo[]> {
  const roots = await collectSearchRoots(loadCtx.agentManifestDir ?? process.cwd(), options);
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

function pickRegisterFn(mod: GlassExtensionModule): RegisterFn | undefined {
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
    glass?: { extension?: string };
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed.glass || typeof parsed.glass.extension !== "string") return null;
  const entryAbs = path.resolve(packageDir, parsed.glass.extension);
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
    options.glassExtensionsDir ??
      path.join(process.env.GLASS_HOME ?? path.join(os.homedir(), ".glass"), "extensions"),
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
