/**
 * `write_file` — write a UTF-8 file, restricted to configured paths.
 *
 * Capabilities:
 *   { paths: string[] }   — path roots the tool will write under.
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

const SCHEMA: JSONSchema = {
  type: "object",
  required: ["path", "content"],
  properties: {
    path: { type: "string", description: "File path to write." },
    content: { type: "string", description: "Full file contents." },
    append: {
      type: "boolean",
      description: "Append instead of overwriting (default false).",
    },
    create_dirs: {
      type: "boolean",
      description: "Create missing parent dirs (default false).",
    },
  },
};

export interface WriteFileCaps {
  paths: string[];
}

export class WriteFileTool implements Tool {
  public readonly name = "write_file";
  public readonly description =
    "Write a UTF-8 file (restricted to configured paths).";
  public readonly inputSchema = SCHEMA;
  public readonly capabilities: WriteFileCaps;

  constructor(config: ToolConfig) {
    this.capabilities = parseCaps(config);
  }

  capabilitiesContain(superset: unknown, subset: unknown): boolean {
    return pathCapsContain(superset, subset);
  }

  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const i = input as {
      path?: unknown;
      content?: unknown;
      append?: unknown;
      create_dirs?: unknown;
    };
    if (typeof i.path !== "string" || !i.path) {
      return { content: "write_file: 'path' is required", isError: true };
    }
    if (typeof i.content !== "string") {
      return {
        content: "write_file: 'content' must be a string",
        isError: true,
      };
    }
    const target = path.resolve(i.path);
    if (!isUnderAny(target, this.capabilities.paths)) {
      return {
        content: `write_file: '${i.path}' is outside the configured paths (${this.capabilities.paths.join(", ") || "none"})`,
        isError: true,
      };
    }
    try {
      if (i.create_dirs) {
        await fs.mkdir(path.dirname(target), { recursive: true });
      }
      if (i.append) {
        await fs.appendFile(target, i.content, "utf8");
      } else {
        await fs.writeFile(target, i.content, "utf8");
      }
      return {
        content: `wrote ${i.content.length} bytes to ${i.path}`,
      };
    } catch (e) {
      return { content: `write_file: ${(e as Error).message}`, isError: true };
    }
  }
}

function parseCaps(config: ToolConfig): WriteFileCaps {
  if (typeof config === "string") return { paths: [] };
  const c = config as { paths?: unknown; capabilities?: { paths?: unknown } };
  const raw = (c.capabilities?.paths ?? c.paths) as unknown;
  return { paths: normalizePaths(raw) };
}
