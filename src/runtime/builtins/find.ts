/**
 * `find` — list files in a directory tree matching a glob pattern.
 *
 * Capability kinds:
 *   optional: ["paths"]
 *
 * Star/list/absent semantics:
 *   paths absent  → smart default `["./"]` (project root)
 *   paths = "*"   → unrestricted
 *   paths = []    → explicit no-access (every call fails)
 *   paths = [...] → allowlist of absolute path roots
 *
 * Glob: `*` matches any non-/ chars; `**` matches any depth.
 */

import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
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
  required: ["pattern"],
  additionalProperties: false,
  properties: {
    pattern: {
      type: "string",
      minLength: 1,
      description:
        "Glob (e.g. '**/*.ts'). * = any non-/ chars; ** = any depth.",
    },
    root: { type: "string", description: "Root to walk (default '.')." },
    limit: {
      type: "number",
      exclusiveMinimum: 0,
      description: "Max results (default 200).",
    },
  },
};

interface FindInput {
  pattern: string;
  root?: string;
  limit?: number;
}

const SKIP = new Set(["node_modules", ".git", "dist", ".cache", ".turbo"]);

export class FindTool implements Tool {
  public readonly name = "find";
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
    this.description = `List files matching a glob pattern (${describePaths(this.granted, this.fromDefault)}).`;
  }

  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const {
      pattern,
      root: requestedRoot = ".",
      limit = 200,
    } = input as FindInput;
    const root = path.resolve(requestedRoot);

    // Effective path set = manifest grant ∪ session trusted paths
    // (read access — listing files is a read).
    const trusted = await collectTrustedPaths(ctx);
    const effective = effectivePaths(this.granted, trusted, "read");
    if (!pathAllowed(root, effective)) {
      return {
        content: `find: root '${requestedRoot}' is outside the granted paths (${describePaths(this.granted, this.fromDefault)})`,
        isError: true,
      };
    }
    let stat;
    try {
      stat = await fs.stat(root);
    } catch (e) {
      return { content: `find: ${(e as Error).message}`, isError: true };
    }
    if (!stat.isDirectory()) {
      return {
        content: `find: '${requestedRoot}' is not a directory`,
        isError: true,
      };
    }

    const re = globToRegex(pattern);
    const matches: string[] = [];
    await walk(root, root, re, matches, limit);
    return { content: matches.join("\n") };
  }
}

async function walk(
  base: string,
  dir: string,
  re: RegExp,
  out: string[],
  limit: number,
): Promise<void> {
  if (out.length >= limit) return;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= limit) return;
    if (SKIP.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs).split(path.sep).join("/");
    if (e.isDirectory()) {
      await walk(base, abs, re, out, limit);
    } else if (e.isFile() || e.isSymbolicLink()) {
      if (re.test(rel)) out.push(rel);
    }
  }
}

function globToRegex(g: string): RegExp {
  const parts = g.split("/");
  let out = "^";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? "";
    if (i > 0) out += "/";
    if (p === "**") {
      out += "(?:.*)";
    } else {
      let segment = "";
      for (const ch of p) {
        if (ch === "*") segment += "[^/]*";
        else if (ch === "?") segment += "[^/]";
        else if (/[.+^${}()|[\]\\]/.test(ch)) segment += "\\" + ch;
        else segment += ch;
      }
      out += segment;
    }
  }
  out += "$";
  return new RegExp(out);
}
