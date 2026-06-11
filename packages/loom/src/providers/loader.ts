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

export interface ContributionRegistration<T> {
  readonly name: string;
  readonly secrets?: SecretNeeds;
  instanceSecretNeeds?(
    config: Record<string, unknown>,
  ): SecretNeeds | undefined;
  readonly configSchema?: JSONSchema;
  readonly requiresParent?: boolean;
  create(
    config: Record<string, unknown>,
    ctx: FactoryContext,
    secrets: Record<string, string>,
    parent?: Agent,
  ): T | Promise<T>;
}

export interface LoomProviderApi {
  registerTools(reg: ContributionRegistration<Tools>): void;
  registerHarness(reg: ContributionRegistration<Harness>): void;
  registerSession(reg: ContributionRegistration<Session>): void;

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
  name: string;
  packageDir: string;
  entryPath: string;
  version?: string;
  description?: string;
}

export interface LoadOptions {
  searchPaths?: string[];
  npmGlobalRoot?: string;
  loomProvidersDir?: string;
}

export interface LoadedProvider {
  info: ProviderPackageInfo;
  toolsContributions: ContributionRegistration<Tools>[];
}

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
    // expandHome before resolve so a leading `~` is not treated as a relative segment.
    const expanded = expandHome(source.path);
    const abs = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(loadCtx.agentManifestDir, expanded);
    return loadProviderFromPath(abs, loadCtx);
  }
  throw new LoomError(`Unknown SourceSpec shape: ${JSON.stringify(source)}`);
}

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

async function collectSearchRoots(
  agentManifestDir: string,
  options: LoadOptions,
): Promise<string[]> {
  const roots: string[] = [...(options.searchPaths ?? [])];

  // Loom-installed packages must win over the surrounding tree, so check here first.
  roots.push(path.join(agentManifestDir, ".loom", "node_modules"));

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
