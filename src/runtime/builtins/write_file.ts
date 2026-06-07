import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ToolCallContent } from "../../types/acp.js";
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
  canonicalizeForGrant,
  canonicalizeRoots,
  describePaths,
  pathAllowed,
  pathGrantContains,
  paths,
  resolvedPaths,
} from "./_path.js";

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
    this.description =
      `Write a UTF-8 file in full (${describePaths(this.granted, this.fromDefault)}). ` +
      `Use this to create new files or wholesale-replace existing ones. ` +
      `For targeted changes to an existing file, use \`edit_file\` instead — ` +
      `it's more efficient and produces a diff for review.`;
  }

  containsGrant(
    superset: CapabilitySet | undefined,
    subset: CapabilitySet,
  ): boolean {
    return pathGrantContains(superset, subset);
  }

  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const i = input as WriteFileInput;
    const target = await canonicalizeForGrant(path.resolve(i.path), "write");
    const allowed = await canonicalizeRoots(this.granted);
    if (!pathAllowed(target, allowed)) {
      return {
        content: `write_file: '${i.path}' is outside the granted paths (${describePaths(this.granted, this.fromDefault)})`,
        isError: true,
      };
    }

    // Best-effort pre-write read for the diff; null oldText for new files.
    let priorContent: string | null = null;
    try {
      if (ctx.client?.readTextFile) {
        priorContent = await ctx.client.readTextFile({ path: target });
      } else {
        priorContent = await fs.readFile(target, "utf8");
      }
    } catch {
      priorContent = null;
    }

    // ACP `fs/writeTextFile` is full-file replacement; append/create_dirs
    // must go through local fs.
    const useClient = ctx.client?.writeTextFile && !i.append && !i.create_dirs;

    try {
      if (useClient) {
        await ctx.client!.writeTextFile!({
          path: target,
          content: i.content,
        });
      } else {
        if (i.create_dirs) {
          await fs.mkdir(path.dirname(target), { recursive: true });
        }
        if (i.append) {
          await fs.appendFile(target, i.content, "utf8");
        } else {
          await fs.writeFile(target, i.content, "utf8");
        }
      }
    } catch (e) {
      return {
        content: `write_file: ${(e as Error).message}`,
        isError: true,
        display: failureDisplay(target, i),
      };
    }

    const finalContent = i.append
      ? (priorContent ?? "") + i.content
      : i.content;

    const diff: ToolCallContent = {
      type: "diff",
      path: target,
      oldText: priorContent,
      newText: finalContent,
    };
    const display: ToolDisplay = {
      title: describeTitle(target, priorContent !== null, i.append === true),
      kind: "edit",
      locations: [{ path: target }],
      content: [diff],
    };

    return {
      content: `wrote ${i.content.length} bytes to ${i.path}`,
      display,
    };
  }
}

function describeTitle(
  target: string,
  existed: boolean,
  append: boolean,
): string {
  const base = path.basename(target);
  if (append) return `Appended to ${base}`;
  if (existed) return `Wrote ${base}`;
  return `Created ${base}`;
}

function failureDisplay(target: string, _i: WriteFileInput): ToolDisplay {
  return {
    title: `Failed to write ${path.basename(target)}`,
    kind: "edit",
    locations: [{ path: target }],
  };
}
