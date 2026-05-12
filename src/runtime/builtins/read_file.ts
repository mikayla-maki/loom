/**
 * `read_file` — read a UTF-8 file, restricted to the granted paths.
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
  ToolDisplay,
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
 * `execute()` may trust `path` is a non-empty string.
 */
const SCHEMA: JSONSchema = {
  type: "object",
  required: ["path"],
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description: "Path to the file to read.",
    },
  },
};

interface ReadFileInput {
  path: string;
}

export class ReadFileTool implements Tool {
  public readonly name = "read_file";
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
    this.description = `Read a UTF-8 file from disk (${describePaths(this.granted, this.fromDefault)}).`;
  }

  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path: requested } = input as ReadFileInput;
    const target = path.resolve(requested);
    // Effective path set = manifest grant ∪ session trusted paths
    // (read-or-better). Trusted paths come from the session and may
    // change per-turn; recomputing here keeps the check honest.
    const trusted = await collectTrustedPaths(ctx);
    const effective = effectivePaths(this.granted, trusted, "read");
    if (!pathAllowed(target, effective)) {
      return {
        content: `read_file: '${requested}' is outside the granted paths (${describePaths(this.granted, this.fromDefault)})`,
        isError: true,
      };
    }

    const display: ToolDisplay = {
      title: `Read ${path.basename(target)}`,
      kind: "read",
      locations: [{ path: target }],
    };

    // ── ACP path: client returns unsaved-buffer contents when applicable ──
    if (ctx.client?.readTextFile) {
      try {
        const text = await ctx.client.readTextFile({ path: target });
        return { content: text, display };
      } catch (e) {
        return {
          content: `read_file: ${(e as Error).message}`,
          isError: true,
          display,
        };
      }
    }

    // ── Fast path: local fs ──
    try {
      const text = await fs.readFile(target, "utf8");
      return { content: text, display };
    } catch (e) {
      return {
        content: `read_file: ${(e as Error).message}`,
        isError: true,
        display,
      };
    }
  }
}
