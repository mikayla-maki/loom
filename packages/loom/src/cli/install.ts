import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

import * as TOML from "toml";
import TOMLWriter from "@iarna/toml";

import { LoomError } from "../errors.js";
import { parseAgentManifest } from "../manifest/parser.js";
import {
  resolveManifest,
  sourceSpecKey,
  isPreBuiltSessionLayer,
  type ResolvedSource,
} from "../manifest/resolver.js";
import { collectToolGroups } from "../manifest/tool-groups.js";
import { planToolGroups } from "../manifest/ceiling.js";
import { nativeBuiltinNames } from "../builtins/tools/native.js";
import { getSessionFactory } from "../builtins/index.js";
import { instantiateFromBinding } from "../runtime/boot.js";
import { ChainedSession } from "../runtime/session-chain.js";
import { resolveAgentStorage } from "../runtime/storage.js";
import { DEFAULT_CLIENT_ACP_CAPABILITIES } from "../runtime/acp-capabilities.js";
import type { Agent, FactoryContext, Session } from "../types/interfaces.js";
import type { AgentManifest, SourceSpec } from "../types/manifest.js";

const exec = promisify(execFile);

export interface InstallOptions {
  frozen?: boolean;
  skipNpmInstall?: boolean;
  log?: (line: string) => void;
}

export interface InstallResult {
  manifestPath: string;
  loomDir: string;
  sources: InstallSourceRecord[];
  ranNpmInstall: boolean;
}

export interface InstallSourceRecord {
  spec: string;
  resolved?: string;
  location: string;
  /** Where the source was referenced from (e.g. `[providers].x` or the
   * label of the skill whose group contributed it). */
  origins: string[];
}

export async function installManifest(
  manifestPath: string,
  options: InstallOptions = {},
): Promise<InstallResult> {
  const log = options.log ?? ((s) => process.stderr.write(s + "\n"));
  const absManifest = path.resolve(manifestPath);
  const manifest = await parseAgentManifest(absManifest);
  const manifestDir = path.dirname(absManifest);
  const loomDir = path.join(manifestDir, ".loom");

  const sources = await harvestSources(manifest);
  if (sources.size === 0) {
    log("loom install: no non-builtin sources in the manifest; nothing to do");
    await fs.mkdir(loomDir, { recursive: true });
    await writeLockfile(manifestDir, manifest, []);
    await writeGitignore(loomDir);
    return {
      manifestPath: absManifest,
      loomDir,
      sources: [],
      ranNpmInstall: false,
    };
  }

  if (options.frozen) {
    const existing = await readLockfile(manifestDir).catch(() => null);
    if (!existing) {
      throw new LoomError(
        `loom install --frozen: ${path.join(loomDir, "lock.toml")} missing. ` +
          `Run \`loom install\` (without --frozen) once to generate it.`,
      );
    }
    const currentHash = await hashManifestFile(absManifest);
    if (existing.manifest_hash !== currentHash) {
      throw new LoomError(
        `loom install --frozen: manifest has changed since the last install. ` +
          `Run \`loom install\` (without --frozen) to refresh the lockfile.`,
      );
    }
    // The manifest hash misses drift in contributed sources: a skill can
    // change the npm/path provider it ships without touching the manifest.
    // Compare the full resolved source set against the lockfile so --frozen
    // catches it.
    const lockedSpecs = new Set((existing.source ?? []).map((s) => s.spec));
    const currentSpecs = new Set(
      [...sources.values()].map((s) => sourceSpecToKey(s.spec)),
    );
    if (!sameSet(lockedSpecs, currentSpecs)) {
      throw new LoomError(
        `loom install --frozen: the set of sources changed since the last ` +
          `install (a dependency or a skill's bundled provider may have ` +
          `drifted). Run \`loom install\` (without --frozen) to refresh the ` +
          `lockfile.`,
      );
    }
  }

  const npmSources: Array<{
    key: string;
    source: { npm: string; version?: string };
  }> = [];
  const pathSources: Array<{
    key: string;
    source: { path: string; subpath?: string };
  }> = [];
  for (const [key, rs] of sources) {
    if ("npm" in rs.spec) npmSources.push({ key, source: rs.spec });
    else if ("path" in rs.spec) pathSources.push({ key, source: rs.spec });
  }
  const originsFor = (key: string): string[] => [
    ...(sources.get(key)?.origins ?? []),
  ];

  for (const { source } of pathSources) {
    const abs = path.isAbsolute(source.path)
      ? source.path
      : path.resolve(manifestDir, source.path);
    try {
      await fs.access(path.join(abs, "package.json"));
    } catch {
      throw new LoomError(
        `loom install: path source '${source.path}' does not contain a package.json (resolved to ${abs}).`,
      );
    }
  }

  await fs.mkdir(loomDir, { recursive: true });
  let ranNpmInstall = false;
  if (npmSources.length > 0 && !options.skipNpmInstall) {
    const pkgJson = generateLoomPackageJson(manifest.name, npmSources);
    await fs.writeFile(
      path.join(loomDir, "package.json"),
      JSON.stringify(pkgJson, null, 2) + "\n",
      "utf8",
    );
    log(
      `loom install: running 'npm install' for ${npmSources.length} package(s)…`,
    );
    try {
      await exec(
        "npm",
        [
          "install",
          "--no-save",
          "--no-package-lock",
          "--no-audit",
          "--no-fund",
        ],
        { cwd: loomDir, timeout: 5 * 60_000 },
      );
    } catch (e) {
      throw new LoomError(
        `loom install: 'npm install' failed in ${loomDir}: ${(e as Error).message}`,
        { cause: e },
      );
    }
    ranNpmInstall = true;
  } else if (npmSources.length > 0 && options.skipNpmInstall) {
    const pkgJson = generateLoomPackageJson(manifest.name, npmSources);
    await fs.writeFile(
      path.join(loomDir, "package.json"),
      JSON.stringify(pkgJson, null, 2) + "\n",
      "utf8",
    );
  }

  const records: InstallSourceRecord[] = [];
  for (const { key, source } of npmSources) {
    const pkgDir = path.join(loomDir, "node_modules", source.npm);
    let resolved: string | undefined;
    try {
      const pj = JSON.parse(
        await fs.readFile(path.join(pkgDir, "package.json"), "utf8"),
      ) as { version?: string };
      resolved = pj.version;
    } catch {
      // npm install skipped or package not yet on disk
    }
    records.push({
      spec: sourceSpecToKey(source),
      ...(resolved ? { resolved } : {}),
      location: path.relative(manifestDir, pkgDir),
      origins: originsFor(key),
    });
  }
  for (const { key, source } of pathSources) {
    const abs = path.isAbsolute(source.path)
      ? source.path
      : path.resolve(manifestDir, source.path);
    records.push({
      spec: sourceSpecToKey(source),
      location: path.relative(manifestDir, abs) || ".",
      origins: originsFor(key),
    });
  }

  await writeLockfile(manifestDir, manifest, records);
  await writeGitignore(loomDir);

  log(`loom install: wrote ${path.join(loomDir, "lock.toml")}`);
  return {
    manifestPath: absManifest,
    loomDir,
    sources: records,
    ranNpmInstall,
  };
}

async function harvestSources(
  manifest: AgentManifest,
): Promise<Map<string, ResolvedSource>> {
  const builtinToolNames = new Set(nativeBuiltinNames());
  // Fold in tool groups the session chain contributes (e.g. a skill that
  // ships its own npm- or path-sourced provider via loom.providers) before
  // harvesting, so those sources install and lock alongside the manifest's
  // own. resolveManifest sees the contributed source because the group's
  // provider is inlined onto the tool entry; `toolOrigins` re-attributes that
  // source to the contributing skill rather than the synthetic tool entry.
  const { augmented, toolOrigins } = await augmentWithContributedGroups(
    manifest,
    builtinToolNames,
  );
  return resolveManifest(augmented, { builtinToolNames, toolOrigins }).sources;
}

// Build the session chain just far enough to collect contributed tool
// groups, then fold the accepted ones into the manifest. Best-effort: the
// skills session is a builtin that only reads SKILL.md, so this needs
// nothing installed first; a session layer sourced from an as-yet
// uninstalled provider simply can't contribute here and is skipped.
async function augmentWithContributedGroups(
  manifest: AgentManifest,
  builtinToolNames: Set<string>,
): Promise<{ augmented: AgentManifest; toolOrigins: Record<string, string> }> {
  const bare = { augmented: manifest, toolOrigins: {} };
  const resolved = resolveManifest(manifest, { builtinToolNames });
  const sessionBindings = resolved.session ?? [];
  if (sessionBindings.length === 0) return bare;

  let storagePath: string;
  try {
    storagePath = (await resolveAgentStorage(manifest)).path;
  } catch {
    return bare;
  }
  const factoryCtx: FactoryContext = {
    manifestDir: manifest.manifestPath
      ? path.dirname(manifest.manifestPath)
      : process.cwd(),
    agentName: manifest.name,
    loomVersion: "install",
    clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
    purpose: "audit",
    storage: storagePath,
    metadata: manifest.metadata ?? {},
  };

  const links: Session[] = [];
  for (const layer of sessionBindings) {
    try {
      if (isPreBuiltSessionLayer(layer)) {
        links.push(layer.instance);
        continue;
      }
      const { instance } = await instantiateFromBinding<Session>(
        layer,
        getSessionFactory,
        factoryCtx,
        {},
        undefined,
        "session",
      );
      links.push(instance);
    } catch {
      // A layer we can't construct yet just doesn't contribute sources.
    }
  }
  if (links.length === 0) return bare;
  const session =
    links.length === 1 ? (links[0] as Session) : new ChainedSession(links);

  let groups;
  try {
    groups = await collectToolGroups(session);
  } catch {
    return bare;
  }
  if (groups.length === 0) return bare;

  try {
    const plan = planToolGroups({
      manifest,
      groups,
      agent: stubInstallAgent(manifest),
    });
    return { augmented: plan.augmented, toolOrigins: plan.origins };
  } catch {
    return bare;
  }
}

// planToolGroups needs an Agent only to probe the tool-owned grant algebra
// of native tools; a throwaway stub suffices here.
function stubInstallAgent(manifest: AgentManifest): Agent {
  return {
    manifest,
    harness: { run: async () => ({ stopReason: "end_turn" }) },
    session: { push: async () => [], pull: async () => [] },
    systemPromptCore: "",
  };
}

function sourceSpecToKey(s: SourceSpec): string {
  return sourceSpecKey(s);
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function generateLoomPackageJson(
  agentName: string,
  npmSources: Array<{ source: { npm: string; version?: string } }>,
): Record<string, unknown> {
  const dependencies: Record<string, string> = {};
  for (const { source } of npmSources) {
    dependencies[source.npm] = source.version ?? "*";
  }
  return {
    name: `loom-deps-${slug(agentName)}`,
    version: "0.0.0",
    private: true,
    dependencies,
  };
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

interface LockfileShape {
  loom_version: string;
  manifest_hash: string;
  generated_at: string;
  source: Array<{
    spec: string;
    resolved?: string;
    location: string;
    origins?: string[];
  }>;
}

async function writeLockfile(
  manifestDir: string,
  manifest: AgentManifest,
  records: InstallSourceRecord[],
): Promise<void> {
  const { LOOM_VERSION } = await import("../sdk/run-agent.js");
  const manifest_hash = manifest.manifestPath
    ? await hashManifestFile(manifest.manifestPath)
    : "sha256:<inline>";
  const lock: LockfileShape = {
    loom_version: LOOM_VERSION,
    manifest_hash,
    generated_at: new Date().toISOString(),
    source: records.map((r) => ({
      spec: r.spec,
      ...(r.resolved !== undefined ? { resolved: r.resolved } : {}),
      location: r.location,
      ...(r.origins.length > 0 ? { origins: r.origins } : {}),
    })),
  };
  const text = TOMLWriter.stringify(lock as unknown as TOMLWriter.JsonMap);
  await fs.writeFile(
    path.join(manifestDir, ".loom", "lock.toml"),
    text,
    "utf8",
  );
}

async function readLockfile(
  manifestDir: string,
): Promise<LockfileShape | null> {
  const p = path.join(manifestDir, ".loom", "lock.toml");
  let text: string;
  try {
    text = await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
  try {
    return TOML.parse(text) as unknown as LockfileShape;
  } catch (e) {
    throw new LoomError(
      `loom install: failed to parse ${p}: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

async function hashManifestFile(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  const h = createHash("sha256").update(buf).digest("hex");
  return `sha256:${h}`;
}

async function writeGitignore(loomDir: string): Promise<void> {
  const p = path.join(loomDir, ".gitignore");
  try {
    await fs.access(p);
    return;
  } catch {
    // doesn't exist yet; generate the default below
  }
  const text =
    "# Generated by `loom install`. lock.toml is the only file in\n" +
    "# this directory worth checking into version control.\n" +
    "node_modules/\n" +
    "package.json\n";
  await fs.writeFile(p, text, "utf8");
}
