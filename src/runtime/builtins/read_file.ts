/**
 * `read_file` — read a UTF-8 file, restricted to configured paths.
 *
 * Capabilities:
 *   { paths: string[] }   — file path roots the tool will read from.
 *
 * Self-policing: at execute time, the requested file path is resolved
 * absolutely; if it isn't under any configured root, the call returns an
 * `isError` result. Tools enforce their own caps because loom doesn't.
 *
 * Skill awareness: loom exposes inline skills (those declared
 * directly in agent.toml without a `skillDir`) under the synthetic
 * `loom-skills:<name>/SKILL.md` scheme. Loom hands the read_file
 * tool a `virtualSkills` map at boot keyed by that path. When the
 * requested path starts with the scheme, the tool looks up in the
 * map and returns the body — no fs access. The scheme is
 * intentionally not a real fs path, so it can't collide with the
 * `paths` allowlist semantics.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  Tool,
  ToolConfig,
  ToolContext,
  ToolResult,
} from "../../types/interfaces.js";
import type { JSONSchema } from "../../types/schema.js";

import { isUnderAny, normalizePaths, pathCapsContain } from "./_path.js";
import { isVirtualSkillPath } from "../skill-paths.js";

const SCHEMA: JSONSchema = {
  type: "object",
  required: ["path"],
  properties: {
    path: { type: "string", description: "Path to the file to read." },
  },
};

export interface ReadFileCaps {
  paths: string[];
}

export class ReadFileTool implements Tool {
  public readonly name = "read_file";
  public readonly description =
    "Read a UTF-8 file from disk (restricted to configured paths).";
  public readonly inputSchema = SCHEMA;
  public readonly capabilities: ReadFileCaps;
  /**
   * Synthetic-path → file-content map for inline skills. Set at boot
   * by `runAgent`; not configurable from the manifest. Keys are the
   * full `loom-skills:<name>/SKILL.md` URIs.
   */
  private readonly virtualSkills: Map<string, string>;

  constructor(config: ToolConfig) {
    this.capabilities = parseCaps(config);
    this.virtualSkills = parseVirtualSkills(config);
  }

  capabilitiesContain(superset: unknown, subset: unknown): boolean {
    return pathCapsContain(superset, subset);
  }

  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const requested = (input as { path?: unknown }).path;
    if (typeof requested !== "string" || !requested) {
      return { content: "read_file: 'path' is required", isError: true };
    }
    if (isVirtualSkillPath(requested)) {
      const text = this.virtualSkills.get(requested);
      if (text === undefined) {
        const known = [...this.virtualSkills.keys()].join(", ") || "(none)";
        return {
          content: `read_file: virtual skill path '${requested}' is not registered. Known: ${known}.`,
          isError: true,
        };
      }
      return { content: text };
    }
    const target = path.resolve(requested);
    if (!isUnderAny(target, this.capabilities.paths)) {
      return {
        content: `read_file: '${requested}' is outside the configured paths (${this.capabilities.paths.join(", ") || "none"})`,
        isError: true,
      };
    }
    try {
      const text = await fs.readFile(target, "utf8");
      return { content: text };
    } catch (e) {
      return { content: `read_file: ${(e as Error).message}`, isError: true };
    }
  }
}

function parseCaps(config: ToolConfig): ReadFileCaps {
  if (typeof config === "string") return { paths: [] };
  const c = config as { paths?: unknown; capabilities?: { paths?: unknown } };
  const raw = (c.capabilities?.paths ?? c.paths) as unknown;
  return { paths: normalizePaths(raw) };
}

function parseVirtualSkills(config: ToolConfig): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof config === "string" || config === null) return out;
  const v = (config as { virtualSkills?: unknown }).virtualSkills;
  if (!v || typeof v !== "object") return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out.set(k, val);
  }
  return out;
}
