import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { LoomError } from "../errors.js";
import type { AgentManifest } from "../types/manifest.js";

export function transientStorage(prefix = "loom-transient"): string {
  return os.tmpdir() + path.sep + prefix;
}

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

export interface AgentStorage {
  path: string;
  source: "storage_id" | "name";
  warnings: string[];
}

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

function sanitizeIdentifier(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function readMetadata(
  metadataPath: string,
): Promise<AgentStorageMetadata | null> {
  try {
    const raw = await fs.readFile(metadataPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentStorageMetadata>;
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
