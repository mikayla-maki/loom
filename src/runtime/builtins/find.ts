/**
 * `find` — list files in a directory tree matching a glob pattern.
 *
 * Capabilities:
 *   { paths: string[] }   — directory roots the search is allowed under.
 *
 * Glob: `*` matches any non-/ chars; `**` matches any depth.
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
  required: ["pattern"],
  properties: {
    pattern: {
      type: "string",
      description:
        "Glob (e.g. '**/*.ts'). * = any non-/ chars; ** = any depth.",
    },
    root: { type: "string", description: "Root to walk (default '.')." },
    limit: { type: "number", description: "Max results (default 200)." },
  },
};

const SKIP = new Set(["node_modules", ".git", "dist", ".cache", ".turbo"]);

export interface FindCaps {
  paths: string[];
}

export class FindTool implements Tool {
  public readonly name = "find";
  public readonly description =
    "List files matching a glob pattern, restricted to configured roots.";
  public readonly inputSchema = SCHEMA;
  public readonly capabilities: FindCaps;

  constructor(config: ToolConfig) {
    this.capabilities = parseCaps(config);
  }

  capabilitiesContain(superset: unknown, subset: unknown): boolean {
    return pathCapsContain(superset, subset);
  }

  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const i = input as {
      pattern?: unknown;
      root?: unknown;
      limit?: unknown;
    };
    if (typeof i.pattern !== "string" || !i.pattern) {
      return { content: "find: 'pattern' is required", isError: true };
    }
    const requestedRoot = typeof i.root === "string" ? i.root : ".";
    const root = path.resolve(requestedRoot);
    const limit = typeof i.limit === "number" && i.limit > 0 ? i.limit : 200;

    if (!isUnderAny(root, this.capabilities.paths)) {
      return {
        content: `find: root '${requestedRoot}' is outside the configured paths (${this.capabilities.paths.join(", ") || "none"})`,
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

    const re = globToRegex(i.pattern);
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
  let entries: import("node:fs").Dirent[];
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

function parseCaps(config: ToolConfig): FindCaps {
  if (typeof config === "string") return { paths: [] };
  const c = config as { paths?: unknown; capabilities?: { paths?: unknown } };
  const raw = (c.capabilities?.paths ?? c.paths) as unknown;
  return { paths: normalizePaths(raw) };
}
