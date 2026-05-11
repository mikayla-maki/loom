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

import {
  collectTrustedPaths,
  describePaths,
  effectivePaths,
  pathAllowed,
  paths,
  resolvedPaths,
} from "./_path.js";

/**
 * Input schema. `ToolTable` validates against this before dispatch —
 * `execute()` may trust the shape.
 */
const SCHEMA: JSONSchema = {
  type: "object",
  required: ["path", "content"],
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description: "File path to write.",
    },
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

interface WriteFileInput {
  path: string;
  content: string;
  append?: boolean;
  create_dirs?: boolean;
}

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

  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const i = input as WriteFileInput;
    const target = path.resolve(i.path);
    // Effective path set = manifest grant ∪ session trusted paths
    // with write access (`"write"` or `"read-write"`). A skills
    // session that advertises `~/.skills/` as read-only therefore
    // does NOT let the agent write there — the access level matters.
    const trusted = await collectTrustedPaths(ctx);
    const effective = effectivePaths(this.granted, trusted, "write");
    if (!pathAllowed(target, effective)) {
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
