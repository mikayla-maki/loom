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
  assertSafeWriteTarget,
  canonicalizeForGrant,
  canonicalizeRoots,
  describePaths,
  openWriteNoFollow,
  pathAllowed,
  pathGrantContains,
  paths,
  resolvedPaths,
  samplePathGrant,
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

  sampleGrant(random: () => number): CapabilitySet {
    return samplePathGrant(random);
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

    // Parent dirs first, so the final-component open below sees a real dir.
    if (i.create_dirs) {
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
      } catch (e) {
        return {
          content: `write_file: ${(e as Error).message}`,
          isError: true,
          display: failureDisplay(target, i),
        };
      }
    }

    // ACP `fs/writeTextFile` is full-file replacement; append/create_dirs
    // must go through local fs.
    const useClient = ctx.client?.writeTextFile && !i.append && !i.create_dirs;

    // Prior content is best-effort, for the diff only; null oldText = new file.
    let priorContent: string | null = null;
    let existed = false;
    try {
      if (useClient) {
        // The editor writes by path — guard the final component (symlink /
        // hard-link escape) before delegating.
        await assertSafeWriteTarget(target);
        try {
          priorContent = await ctx.client!.readTextFile!({ path: target });
          existed = priorContent !== null;
        } catch {
          priorContent = null;
        }
        await ctx.client!.writeTextFile!({ path: target, content: i.content });
      } else {
        // Open the final component without following a terminal symlink and
        // write THROUGH the fd, closing the check-then-write race; reject
        // hard-link aliases. See openWriteNoFollow.
        const { handle, existed: pre } = await openWriteNoFollow(target, {
          append: i.append === true,
          create: true,
        });
        existed = pre;
        try {
          if (existed) {
            try {
              priorContent = await handle.readFile({ encoding: "utf8" });
            } catch {
              priorContent = null;
            }
          }
          if (i.append) {
            await handle.write(i.content, null, "utf8");
          } else {
            await handle.truncate(0);
            await handle.write(i.content, 0, "utf8");
          }
        } finally {
          await handle.close();
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
      title: describeTitle(target, existed, i.append === true),
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
