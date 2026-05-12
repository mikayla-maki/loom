/**
 * `loom install` — materialise the manifest's npm and path dependencies
 * so `loom run` can resolve them at boot. See `internal-docs/manifest-v3.md`
 * §3 for the full design.
 *
 * Layout (per manifest dir):
 *
 *   <manifest-dir>/
 *   ├── agent.toml
 *   ├── .loom/
 *   │   ├── package.json          (generated; npm deps from manifest)
 *   │   ├── node_modules/         (npm install output)
 *   │   └── lock.toml             (canonical lockfile; safe to commit)
 *
 * `lock.toml` records each source the manifest references and what was
 * on disk after the install. `loom run` consumes the manifest directly
 * — the lockfile is currently informational, surfaced via `loom audit`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

import TOML from "@iarna/toml";

import { LoomError } from "../errors.js";
import { parseAgentManifest } from "../manifest/parser.js";
import { resolveManifest, sourceSpecKey } from "../manifest/resolver.js";
import { nativeBuiltinNames } from "../builtins/tools/native.js";
import type { AgentManifest, SourceSpec } from "../types/manifest.js";

const exec = promisify(execFile);

export interface InstallOptions {
  /**
   * If true, exit with an error when `lock.toml` is missing or stale.
   * Used by CI / reproducible builds: refuses to discover new versions.
   */
  frozen?: boolean;
  /**
   * Skip the actual `npm install` step. Used by tests that pre-populate
   * `.loom/node_modules` themselves (no network needed) but still want
   * the lockfile written.
   */
  skipNpmInstall?: boolean;
  /**
   * Where to log progress. Defaults to stderr; pass a no-op writer to
   * silence (e.g. when running install programmatically).
   */
  log?: (line: string) => void;
}

export interface InstallResult {
  manifestPath: string;
  loomDir: string;
  /** Per-source resolved location (relative to manifestDir). */
  sources: InstallSourceRecord[];
  /** True if `npm install` was actually run. */
  ranNpmInstall: boolean;
}

export interface InstallSourceRecord {
  spec: string;
  /** Resolved version (npm) or absolute path on disk. */
  resolved?: string;
  location: string;
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

  // ─── 1. Harvest sources from the manifest ──────────────────────
  // ─── 1. Harvest sources from the manifest ──────────────
  const sources = harvestSources(manifest);
  if (sources.size === 0) {
    log("loom install: no non-builtin sources in the manifest; nothing to do");
    // Still write the empty lockfile + .gitignore so `--frozen` has
    // something to verify against and the directory is git-friendly.
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

  // ─── 2. Frozen mode: refuse if lockfile is stale ───────────────
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
  }

  // ─── 3. Split into npm vs path; validate path sources eagerly ───
  const npmSources: Array<{
    key: string;
    source: { npm: string; version?: string };
  }> = [];
  const pathSources: Array<{
    key: string;
    source: { path: string; subpath?: string };
  }> = [];
  for (const [key, source] of sources) {
    if ("npm" in source) npmSources.push({ key, source });
    else if ("path" in source) pathSources.push({ key, source });
  }

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

  // ─── 4. Write .loom/package.json + run npm install ──────────────
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
    // Still write the package.json so the install step is reproducible
    // by hand even when the tool is skipping the npm command itself.
    const pkgJson = generateLoomPackageJson(manifest.name, npmSources);
    await fs.writeFile(
      path.join(loomDir, "package.json"),
      JSON.stringify(pkgJson, null, 2) + "\n",
      "utf8",
    );
  }

  // ─── 5. Build install records (read versions from node_modules) ─
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
      // npm install was skipped or the package isn't on disk yet;
      // the lockfile still records what the manifest asked for.
    }
    records.push({
      spec: sourceSpecToKey(source),
      ...(resolved ? { resolved } : {}),
      location: path.relative(manifestDir, pkgDir),
    });
    void key;
  }
  for (const { source } of pathSources) {
    const abs = path.isAbsolute(source.path)
      ? source.path
      : path.resolve(manifestDir, source.path);
    records.push({
      spec: sourceSpecToKey(source),
      location: path.relative(manifestDir, abs) || ".",
    });
  }

  // ─── 6. Write .loom/lock.toml + .gitignore ─────────────────────
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

// ──────────────────────────────────────────────────────────────────────
// Source harvesting.
// ──────────────────────────────────────────────────────────────────────

/**
 * Run the manifest through the resolver and collect every distinct
 * SourceSpec it references — declared `[providers]` handles plus
 * inline references from `[tools]`, `[harness].provider`,
 * `[session].provider`. The resolver dedupes by canonical key, so
 * the install step and the runtime see the same set.
 */
function harvestSources(manifest: AgentManifest): Map<string, SourceSpec> {
  const builtinToolNames = new Set(nativeBuiltinNames());
  const resolved = resolveManifest(manifest, { builtinToolNames });
  const out = new Map<string, SourceSpec>();
  for (const [key, rs] of resolved.sources) {
    out.set(key, rs.spec);
  }
  return out;
}

function sourceSpecToKey(s: SourceSpec): string {
  return sourceSpecKey(s);
}

// ──────────────────────────────────────────────────────────────────────
// Generated files.
// ──────────────────────────────────────────────────────────────────────

function generateLoomPackageJson(
  agentName: string,
  npmSources: Array<{ source: { npm: string; version?: string } }>,
): Record<string, unknown> {
  const dependencies: Record<string, string> = {};
  for (const { source } of npmSources) {
    // If two manifest entries pin the same package to different
    // versions, the harvest map already deduped them by source key
    // (`npm:<name>@<ver>`), so each entry here has a unique key.
    // npm itself will only install one version per name, though, so
    // a mismatch would surface there. We keep the last-wins behaviour
    // (consistent with TOML overwrite semantics).
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
    })),
  };
  // @iarna/toml stringifies arrays-of-tables as `[[source]]` blocks.
  const text = TOML.stringify(lock as unknown as TOML.JsonMap);
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
    return; // already exists; leave the user's tweaks alone
  } catch {
    // not present; generate the default
  }
  const text =
    "# Generated by `loom install`. lock.toml is the only file in\n" +
    "# this directory worth checking into version control.\n" +
    "node_modules/\n" +
    "package.json\n";
  await fs.writeFile(p, text, "utf8");
}
