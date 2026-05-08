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
  ToolResult,
} from "../../types/interfaces.js";
import type { CapabilitySet } from "../../types/manifest.js";
import type { JSONSchema } from "../../types/schema.js";

import { describePaths, pathAllowed, paths, resolvedPaths } from "./_path.js";

const SCHEMA: JSONSchema = {
  type: "object",
  required: ["path"],
  properties: {
    path: { type: "string", description: "Path to the file to read." },
  },
};

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

  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const requested = (input as { path?: unknown }).path;
    if (typeof requested !== "string" || !requested) {
      return { content: "read_file: 'path' is required", isError: true };
    }
    const target = path.resolve(requested);
    if (!pathAllowed(target, this.granted)) {
      return {
        content: `read_file: '${requested}' is outside the granted paths (${describePaths(this.granted, this.fromDefault)})`,
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
