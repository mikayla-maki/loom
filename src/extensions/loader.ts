/**
 * Extension package loader.
 *
 * A Glass extension is just an ordinary npm/Node package with a `glass.extension`
 * field in its package.json pointing at an entry that exports a `register()`
 * function:
 *
 *   {
 *     "name": "mcp-glass-extension",
 *     "version": "0.1.0",
 *     "glass": { "extension": "./dist/index.js" }
 *   }
 *
 *   // dist/index.js
 *   export function register(api) {
 *     api.registerProvider({ name: "mcp", create(config, ctx) { ... } });
 *   }
 *
 * Discovery is global (npm install -g, npm install in the project dir, or
 * placing the package under ~/.glass/extensions/). Activation is explicit:
 * an agent.toml's [extensions] table lists the packages it wants loaded
 * by name. This matches the security model — extensions run as the
 * runtime trust class, so they should only run when the agent author
 * opts in by name.
 *
 * `npm install github:user/repo`, `npm install file:./path`, etc. all work
 * out of the box: once installed, the package is just a directory with a
 * package.json and an entry — same as anything else.
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

import {
  registerHarness,
  registerProvider,
  registerSession,
} from "./index.js";

const exec = promisify(execFile);

/** API surface a Glass extension's register() function receives. */
export interface GlassExtensionApi {
  /** Register a Harness *factory* by name; the user activates it via [harness].provider. */
  registerHarness(factory: HarnessFactory): void;
  /** Register a Session *factory* by name; activated via [session].provider. */
  registerSession(factory: SessionFactory): void;
  /** Register a Provider *factory* by name; activated via [providers].<name>. */
  registerProvider(factory: ProviderFactory): void;
  /**
   * Auto-activate a Provider *instance* for the current agent. Use this
   * for the common case ("list this extension and you get its tools/skills")
   * — no entry in [providers] required.
   */
  addProvider(provider: Provider): void;
  /** Read-only context: which agent loaded this extension. */
  readonly agentName: string;
  /** Manifest dir of the agent that loaded this extension. */
  readonly manifestDir: string;
  /** Glass version. */
  readonly glassVersion: string;
  /** Per-extension config from the agent.toml [extensions].<name> table. */
  readonly config: Record<string, unknown>;
}

/** The shape an extension package must export. */
export interface GlassExtensionModule {
  /** ESM/CJS-named export. */
  register?: (api: GlassExtensionApi) => void | Promise<void>;
  /** Default export — the same callable. */
  default?: ((api: GlassExtensionApi) => void | Promise<void>) | { register: GlassExtensionModule["register"] };
}

export interface ExtensionPackageInfo {
  /** Bare package name (e.g. "mcp-glass-extension"). */
  name: string;
  /** Resolved absolute directory of the package. */
  packageDir: string;
  /** Absolute path to the entry module. */
  entryPath: string;
  /** Package.json `version`, if any. */
  version?: string;
  /** Package.json `description`, if any. */
  description?: string;
}

export interface LoadOptions {
  /**
   * Extra directories to consult for package resolution, in priority order
   * BEFORE the built-in search paths. Tests use this to point at a
   * fixtures directory.
   */
  searchPaths?: string[];
  /** Override the npm global root (defaults to `npm root -g`). */
  npmGlobalRoot?: string;
  /** Cached glass-extensions root (defaults to ~/.glass/extensions). */
  glassExtensionsDir?: string;
}

/** Resolve an extension package by name. Throws GlassError if not found / invalid. */
export async function locateExtensionPackage(
  name: string,
  loadCtx: { agentManifestDir: string },
  options: LoadOptions = {},
): Promise<ExtensionPackageInfo> {
  const candidates = await collectSearchRoots(loadCtx.agentManifestDir, options);
  for (const root of candidates) {
    const dir = path.join(root, name);
    const info = await tryLoadPackageJson(dir, name);
    if (info) return info;
  }
  throw new GlassError(
    `Cannot find Glass extension package '${name}'. Searched: ${candidates.join(", ")}. ` +
      `Install it with 'npm install ${name}' (locally) or 'npm install -g ${name}' (globally), ` +
      `or place it under ~/.glass/extensions/${name}/.`,
  );
}

/**
 * Load + activate an extension. Imports the package's entry module,
 * locates its register() function, and calls it. Returns:
 *   - info        : metadata about the loaded package
 *   - addedProviders : Provider instances the extension auto-activated
 *                     via api.addProvider() (caller plumbs these into
 *                     options.providers for resolveAgent).
 */
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
  const register =
    mod.register ??
    (typeof mod.default === "function"
      ? mod.default
      : (mod.default && typeof (mod.default as { register?: unknown }).register === "function"
          ? (mod.default as { register: GlassExtensionModule["register"] }).register
          : undefined));
  if (typeof register !== "function") {
    throw new GlassError(
      `Glass extension '${name}' does not export a register() function (entry: ${info.entryPath})`,
    );
  }
  const addedProviders: Provider[] = [];
  const api: GlassExtensionApi = {
    registerHarness,
    registerSession,
    registerProvider,
    addProvider: (p) => {
      addedProviders.push(p);
    },
    agentName: loadCtx.agentName,
    manifestDir: loadCtx.agentManifestDir,
    glassVersion: loadCtx.glassVersion,
    config,
  };
  await register(api);
  return { info, addedProviders };
}

/**
 * Walk all known search roots and list installable Glass extensions
 * (packages whose `package.json` has a `glass.extension` field).
 */
export async function listInstalledExtensions(
  loadCtx: { agentManifestDir?: string } = {},
  options: LoadOptions = {},
): Promise<ExtensionPackageInfo[]> {
  const roots = await collectSearchRoots(loadCtx.agentManifestDir ?? process.cwd(), options);
  const seen = new Set<string>();
  const out: ExtensionPackageInfo[] = [];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Support scoped packages (@scope/name).
      if (entry.startsWith("@")) {
        let inner: string[] = [];
        try {
          inner = await fs.readdir(path.join(root, entry));
        } catch {
          continue;
        }
        for (const sub of inner) {
          const fullName = `${entry}/${sub}`;
          if (seen.has(fullName)) continue;
          const info = await tryLoadPackageJson(path.join(root, entry, sub), fullName);
          if (info) {
            seen.add(fullName);
            out.push(info);
          }
        }
        continue;
      }
      if (seen.has(entry)) continue;
      const info = await tryLoadPackageJson(path.join(root, entry), entry);
      if (info) {
        seen.add(entry);
        out.push(info);
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function tryLoadPackageJson(
  packageDir: string,
  expectedName: string,
): Promise<ExtensionPackageInfo | null> {
  const pj = path.join(packageDir, "package.json");
  let raw: string;
  try {
    raw = await fs.readFile(pj, "utf8");
  } catch {
    return null;
  }
  let parsed: {
    name?: string;
    version?: string;
    description?: string;
    main?: string;
    module?: string;
    glass?: { extension?: string };
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // Only count packages that explicitly declare themselves as Glass extensions.
  // (npm-install side effects shouldn't accidentally surface unrelated
  //  packages.)
  const glassMeta = parsed.glass;
  if (!glassMeta || typeof glassMeta.extension !== "string") return null;
  const entryRel = glassMeta.extension;
  const entryAbs = path.resolve(packageDir, entryRel);
  // Sanity: package's declared name should match what we asked for, but we
  // accept any — the directory name is canonical for our purposes.
  void parsed.name;
  void expectedName;
  // Verify the entry file exists.
  try {
    await fs.access(entryAbs);
  } catch {
    return null;
  }
  return {
    name: parsed.name ?? expectedName,
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
  const roots: string[] = [];
  for (const sp of options.searchPaths ?? []) roots.push(sp);

  // 1. <manifestDir>/node_modules (project-local install).
  roots.push(path.join(agentManifestDir, "node_modules"));
  // Walk up to nearest containing node_modules (mimics Node's resolver).
  let dir = agentManifestDir;
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    roots.push(path.join(dir, "node_modules"));
  }

  // 2. npm global root.
  const globalRoot = options.npmGlobalRoot ?? (await getNpmGlobalRoot());
  if (globalRoot) roots.push(globalRoot);

  // 3. ~/.glass/extensions
  roots.push(
    options.glassExtensionsDir ??
      path.join(process.env.GLASS_HOME ?? path.join(os.homedir(), ".glass"), "extensions"),
  );

  // Dedupe while preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    if (!r || seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

async function getNpmGlobalRoot(): Promise<string | null> {
  try {
    const { stdout } = await exec("npm", ["root", "-g"], { timeout: 5000 });
    const trimmed = stdout.trim();
    if (trimmed) return trimmed;
  } catch {
    // npm not available or errored — that's fine, just skip this root.
  }
  return null;
}
