/**
 * Per-host data home + per-agent storage root resolution.
 *
 * Loom plugins (sessions, harnesses, Tools factories) all need
 * somewhere on disk to keep state — cached tool lists, notes
 * files, session journals, PID files for graceful crash recovery.
 * Before this module they each invented their own scheme. After:
 * Loom hands every plugin one absolute directory via
 * `FactoryContext.storage` and stays out of the way.
 *
 * Two layers:
 *
 *   1. **`resolveLoomDataHome()`** — pure, no I/O. Where should
 *      the host's data live? Honors `$LOOM_DATA_HOME` first; else
 *      platform conventions (macOS / Linux-XDG / Windows / other).
 *
 *   2. **`resolveAgentStorage(manifest)`** — has side effects.
 *      Creates `<dataHome>/agents/<sanitized-id>/` if missing,
 *      drops a `.loom-agent` metadata file, returns the absolute
 *      path. Detects collisions (two manifests claiming the same
 *      id from different on-disk paths) and surfaces them as
 *      warnings rather than errors — sharing state across
 *      manifests is a legitimate use case; accidentally sharing
 *      is a user error the warning makes visible.
 *
 * Loom does NOT impose a sub-layout under the agent root. Plugins
 * decide. Convention (not enforced): namespace by factory name,
 * e.g. `<storage>/notes-provider/notes.md` or
 * `<storage>/mcp/<provider-handle>/tools-list.json`. Loom owns
 * `.loom-agent` and nothing else.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { LoomError } from "../errors.js";
import type { AgentManifest } from "../types/manifest.js";

/**
 * Throwaway storage path for transient `FactoryContext` consumers
 * — `loom mcp inspect`, ACP capability probes, anything else that
 * constructs Tools just to introspect them. Returns an absolute
 * path under `os.tmpdir()` that already exists; callers don't need
 * to clean it up (tmpdir is host-managed).
 *
 * Plugins are guaranteed that `ctx.storage` is real and writable,
 * so probe-style callers must give them SOMETHING. They shouldn't
 * use the real per-agent storage — that would create a
 * `<dataHome>/agents/loom-acp-probe/` directory on every probe.
 */
export function transientStorage(prefix = "loom-transient"): string {
  return os.tmpdir() + path.sep + prefix;
}

// ─── Step 1: data-home resolution ────────────────────────────────────────

/**
 * Resolve the per-host root under which all Loom agent storage
 * lives. Pure: reads only `env` (defaulting to `process.env`); no
 * filesystem side effects.
 *
 * Precedence:
 *
 *   1. `$LOOM_DATA_HOME` if set (useful for tests, CI, sandboxes).
 *   2. Platform default:
 *
 *      | Platform | Path                                          |
 *      |----------|-----------------------------------------------|
 *      | macOS    | `~/Library/Application Support/Loom`          |
 *      | Linux    | `$XDG_DATA_HOME/loom` (≡ `~/.local/share/loom`) |
 *      | Windows  | `%APPDATA%/Loom`                              |
 *      | other    | `$HOME/.loom`                                 |
 *
 * Throws when neither `LOOM_DATA_HOME` nor `HOME` (`USERPROFILE` on
 * Windows) is resolvable — a host with no home directory is a
 * configuration problem the user should know about.
 */
export function resolveLoomDataHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.LOOM_DATA_HOME;
  if (override && override.length > 0) return path.resolve(override);

  const home = env.HOME ?? env.USERPROFILE;
  if (platform === "darwin") {
    if (!home) throw missingHomeError();
    return path.join(home, "Library", "Application Support", "Loom");
  }
  if (platform === "win32") {
    const appData = env.APPDATA;
    if (appData && appData.length > 0) return path.join(appData, "Loom");
    if (!home) throw missingHomeError();
    return path.join(home, "AppData", "Roaming", "Loom");
  }
  if (platform === "linux") {
    const xdg = env.XDG_DATA_HOME;
    if (xdg && xdg.length > 0) return path.join(xdg, "loom");
    if (!home) throw missingHomeError();
    return path.join(home, ".local", "share", "loom");
  }
  // Unknown platform (freebsd, openbsd, sunos, etc.): conservative
  // fallback to ~/.loom so users get something sensible.
  if (!home) throw missingHomeError();
  return path.join(home, ".loom");
}

function missingHomeError(): LoomError {
  return new LoomError(
    "Cannot resolve Loom data home: neither LOOM_DATA_HOME nor HOME " +
      "(USERPROFILE on Windows) is set. Set LOOM_DATA_HOME=<some/dir> " +
      "to override or configure the home environment.",
  );
}

// ─── Step 2: per-agent storage directory ─────────────────────────────────

/**
 * Resolved per-agent storage root with provenance + warnings.
 */
export interface AgentStorage {
  /** Absolute path. Loom guarantees this directory exists. */
  path: string;
  /** Which manifest field the identifier came from. */
  source: "storage_id" | "name";
  /**
   * Non-fatal warnings produced during resolution \u2014 today only:
   * "this storage was created by a different manifest path".
   * Sharing state across manifests is legitimate; the warning
   * exists so users notice when it's *accidental*.
   */
  warnings: string[];
}

/**
 * The on-disk metadata file Loom drops at the root of each agent's
 * storage directory. Used to detect cross-manifest sharing of the
 * same storage id.
 *
 * Loom owns this file's name (`.loom-agent`) and shape. Plugins
 * MUST NOT overwrite it; they may read it for diagnostics.
 */
interface AgentStorageMetadata {
  agentName: string;
  storageId: string;
  createdAt: string;
  createdByManifest: string | null;
  lastSeenAt: string;
  lastSeenByManifest: string | null;
  knownManifests: string[];
}

const METADATA_FILENAME = ".loom-agent";

/**
 * Create (or open) the storage directory for an agent. Side effects:
 *
 *   1. `mkdir -p <dataHome>/agents/<sanitized-id>/`
 *   2. Read or write `<storage>/.loom-agent` metadata.
 *   3. If the existing metadata records a different `manifestPath`,
 *      add a collision warning to the result.
 *
 * `manifest.storageId` overrides `manifest.name` when set.
 *
 * Throws on illegal identifiers (containing `/` or `\` after\n * sanitization, or empty).
 */
export async function resolveAgentStorage(
  manifest: AgentManifest,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<AgentStorage> {
  const dataHome = resolveLoomDataHome(env, platform);
  const rawId = manifest.storageId ?? manifest.name;
  const source: "storage_id" | "name" = manifest.storageId
    ? "storage_id"
    : "name";
  if (!rawId || rawId.length === 0) {
    throw new LoomError(
      "resolveAgentStorage: manifest has no storage identifier " +
        "(both [agent].storage_id and [agent].name are empty).",
    );
  }
  if (rawId.includes("/") || rawId.includes("\\")) {
    throw new LoomError(
      `resolveAgentStorage: identifier '${rawId}' contains a path ` +
        `separator. Use [agent].storage_id with letters, digits, ` +
        `underscore, dash, or dot.`,
    );
  }
  const sanitized = sanitizeIdentifier(rawId);
  const storagePath = path.join(dataHome, "agents", sanitized);
  await fs.mkdir(storagePath, { recursive: true });

  const metadataPath = path.join(storagePath, METADATA_FILENAME);
  const now = new Date().toISOString();
  const existing = await readMetadata(metadataPath);
  const warnings: string[] = [];

  let metadata: AgentStorageMetadata;
  if (existing) {
    // Re-open. Collision check against `manifest.manifestPath`.
    const currentManifest = manifest.manifestPath ?? null;
    if (
      currentManifest &&
      existing.lastSeenByManifest &&
      existing.lastSeenByManifest !== currentManifest
    ) {
      warnings.push(
        `agent storage '${sanitized}' was previously opened by ` +
          `${existing.lastSeenByManifest}; now opened by ` +
          `${currentManifest}. If this is intentional (e.g. two ` +
          `manifests deliberately sharing state), ignore this. If not, ` +
          `set a distinct [agent].storage_id on one of them.`,
      );
    }
    const knownManifests = [...existing.knownManifests];
    if (currentManifest && !knownManifests.includes(currentManifest)) {
      knownManifests.push(currentManifest);
    }
    metadata = {
      ...existing,
      lastSeenAt: now,
      lastSeenByManifest: currentManifest,
      knownManifests,
    };
  } else {
    // First open.
    metadata = {
      agentName: manifest.name,
      storageId: sanitized,
      createdAt: now,
      createdByManifest: manifest.manifestPath ?? null,
      lastSeenAt: now,
      lastSeenByManifest: manifest.manifestPath ?? null,
      knownManifests: manifest.manifestPath ? [manifest.manifestPath] : [],
    };
  }
  await writeMetadata(metadataPath, metadata);

  return { path: storagePath, source, warnings };
}

/**
 * Replace path-unfriendly characters with `_`. The check above
 * already rejects `/` and `\`; here we tolerate other punctuation
 * silently so common names like `my agent` or `bot@v2` resolve to
 * something the FS can hold.
 */
function sanitizeIdentifier(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function readMetadata(
  metadataPath: string,
): Promise<AgentStorageMetadata | null> {
  try {
    const raw = await fs.readFile(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentStorageMetadata>;
    // Defensive: an old or hand-edited file may be missing fields.
    // Treat anything malformed as "no prior metadata" rather than
    // crashing — the caller writes fresh metadata immediately
    // afterward.
    if (
      typeof parsed.agentName === "string" &&
      typeof parsed.storageId === "string" &&
      typeof parsed.createdAt === "string"
    ) {
      return {
        agentName: parsed.agentName,
        storageId: parsed.storageId,
        createdAt: parsed.createdAt,
        createdByManifest: parsed.createdByManifest ?? null,
        lastSeenAt: parsed.lastSeenAt ?? parsed.createdAt,
        lastSeenByManifest:
          parsed.lastSeenByManifest ?? parsed.createdByManifest ?? null,
        knownManifests: Array.isArray(parsed.knownManifests)
          ? parsed.knownManifests.filter(
              (m): m is string => typeof m === "string",
            )
          : [],
      };
    }
    return null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function writeMetadata(
  metadataPath: string,
  metadata: AgentStorageMetadata,
): Promise<void> {
  await fs.writeFile(
    metadataPath,
    JSON.stringify(metadata, null, 2) + "\n",
    "utf8",
  );
}
