/**
 * `write_file` — write a UTF-8 file, restricted to the granted paths.
 *
 * Capability kinds:
 *   optional: ["paths"]
 *
 * Star/list/absent semantics:
 *   paths absent  → smart default `["./"]` (project root)
 *   paths = "*"   → unrestricted
 *   paths = []    → explicit no-access (every call fails)
 *   paths = [...] → allowlist of absolute path roots
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  Tool,
  ToolConfig,
  ToolContext,
  ToolResult,
} from "../../types/interfaces.js";
import type { CapabilitySet } from "../../types/manifest.js";
import type { JSONSchema } from "../../types/schema.js";

import { describePaths, pathAllowed, paths, resolvedPaths } from "./_path.js";

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

export class WriteFileTool implements Tool {
  public readonly name = "write_file";
  public readonly description: string;
  public readonly inputSchema = SCHEMA;
  public readonly optional = ["paths"];
  public readonly capabilities: CapabilitySet;
  private readonly granted: "*" | string[];
  private readonly fromDefault: boolean;

  constructor(_config: ToolConfig, capabilities: CapabilitySet | undefined) {
    this.capabilities = capabilities ?? {};
    this.fromDefault = paths(this.capabilities) === null;
    this.granted = resolvedPaths(this.capabilities);
    this.description = `Write a UTF-8 file (${describePaths(this.granted, this.fromDefault)}).`;
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
    if (!pathAllowed(target, this.granted)) {
      return {
        content: `write_file: '${i.path}' is outside the granted paths (${describePaths(this.granted, this.fromDefault)})`,
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
