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
  PathSecurityError,
  pathAllowed,
  pathGrantContains,
  paths,
  resolvedPaths,
  samplePathGrant,
} from "./_path.js";

const SCHEMA: JSONSchema = {
  type: "object",
  required: ["path", "edits"],
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description: "Path to the file to edit (must already exist).",
    },
    edits: {
      type: "array",
      minItems: 1,
      description:
        "One or more exact-text replacements. Each entry's `old_text` " +
        "must match a unique substring of the original file. Edits " +
        "are applied against the original content, not incrementally " +
        "— do not provide overlapping or nested matches.",
      items: {
        type: "object",
        required: ["old_text", "new_text"],
        additionalProperties: false,
        properties: {
          old_text: {
            type: "string",
            description:
              "Exact text to find in the file. Must be unique — if " +
              "the same span appears more than once, include enough " +
              "surrounding context to disambiguate.",
          },
          new_text: {
            type: "string",
            description: "Replacement text for this match.",
          },
        },
      },
    },
  },
};

interface EditFileInput {
  path: string;
  edits: Array<{ old_text: string; new_text: string }>;
}

export class EditFileTool implements Tool {
  public readonly name = "edit_file";
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
      `Edit an existing UTF-8 file by exact text replacement ` +
      `(${describePaths(this.granted, this.fromDefault)}). Each edit's ` +
      `\`old_text\` must match a unique substring; all edits apply against ` +
      `the original file. To create a new file, use \`write_file\` instead.`;
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
    const i = input as EditFileInput;
    const target = await canonicalizeForGrant(path.resolve(i.path), "write");

    const allowed = await canonicalizeRoots(this.granted);
    if (!pathAllowed(target, allowed)) {
      return {
        content: `edit_file: '${i.path}' is outside the granted paths (${describePaths(this.granted, this.fromDefault)})`,
        isError: true,
      };
    }

    // When the ACP client can both read and write, route through it so the
    // agent sees (and the editor keeps) unsaved buffer changes. Otherwise write
    // through a validated fd that never follows a terminal symlink and rejects
    // hard-link aliases (see openWriteNoFollow).
    const useClient = !!(ctx.client?.readTextFile && ctx.client?.writeTextFile);

    if (useClient) {
      try {
        await assertSafeWriteTarget(target);
      } catch (e) {
        return { content: `edit_file: ${(e as Error).message}`, isError: true };
      }
      let oldContent: string;
      try {
        oldContent = await ctx.client!.readTextFile!({ path: target });
      } catch (e) {
        return {
          content: `edit_file: ${(e as Error).message}. Use write_file to create new files.`,
          isError: true,
        };
      }
      let newContent: string;
      try {
        newContent = applyEdits(oldContent, i.edits);
      } catch (e) {
        return { content: `edit_file: ${(e as Error).message}`, isError: true };
      }
      try {
        await ctx.client!.writeTextFile!({ path: target, content: newContent });
      } catch (e) {
        return { content: `edit_file: ${(e as Error).message}`, isError: true };
      }
      return editResult(target, oldContent, newContent, i.edits.length, i.path);
    }

    let handle;
    try {
      ({ handle } = await openWriteNoFollow(target, {
        append: false,
        create: false,
      }));
    } catch (e) {
      if (e instanceof PathSecurityError) {
        return { content: `edit_file: ${e.message}`, isError: true };
      }
      return {
        content: `edit_file: ${(e as Error).message}. Use write_file to create new files.`,
        isError: true,
      };
    }

    try {
      const oldContent = await handle.readFile({ encoding: "utf8" });
      let newContent: string;
      try {
        newContent = applyEdits(oldContent, i.edits);
      } catch (e) {
        return { content: `edit_file: ${(e as Error).message}`, isError: true };
      }
      await handle.truncate(0);
      await handle.write(newContent, 0, "utf8");
      return editResult(target, oldContent, newContent, i.edits.length, i.path);
    } catch (e) {
      return { content: `edit_file: ${(e as Error).message}`, isError: true };
    } finally {
      await handle.close();
    }
  }
}

function editResult(
  target: string,
  oldContent: string,
  newContent: string,
  editCount: number,
  requestedPath: string,
): ToolResult {
  const diff: ToolCallContent = {
    type: "diff",
    path: target,
    oldText: oldContent,
    newText: newContent,
  };
  const display: ToolDisplay = {
    title: `Edited ${path.basename(target)} (${editCount} block${editCount === 1 ? "" : "s"})`,
    kind: "edit",
    locations: [{ path: target }],
    content: [diff],
  };
  return {
    content: `Replaced ${editCount} block${editCount === 1 ? "" : "s"} in ${requestedPath}.`,
    display,
  };
}

export function applyEdits(
  original: string,
  edits: ReadonlyArray<{ old_text: string; new_text: string }>,
): string {
  if (edits.length === 0) {
    throw new Error("no edits provided");
  }

  const ranges: Array<{
    start: number;
    end: number;
    newText: string;
    index: number;
  }> = [];
  for (const [index, edit] of edits.entries()) {
    if (typeof edit.old_text !== "string" || edit.old_text.length === 0) {
      throw new Error(`edits[${index}].old_text must be a non-empty string`);
    }
    const first = original.indexOf(edit.old_text);
    if (first === -1) {
      throw new Error(
        `edits[${index}].old_text not found in file. Include more ` +
          `context around the change so it matches a unique location, ` +
          `or re-read the file if it has changed.`,
      );
    }
    const second = original.indexOf(edit.old_text, first + 1);
    if (second !== -1) {
      throw new Error(
        `edits[${index}].old_text matches more than once at positions ${first} and ${second}. ` +
          `Include more surrounding context so the match is unique.`,
      );
    }
    ranges.push({
      start: first,
      end: first + edit.old_text.length,
      newText: edit.new_text,
      index,
    });
  }

  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1]!;
    const cur = ranges[i]!;
    if (cur.start < prev.end) {
      throw new Error(
        `edits[${prev.index}] and edits[${cur.index}] overlap or are nested. ` +
          `Merge them into a single edit instead.`,
      );
    }
  }

  let cursor = 0;
  const out: string[] = [];
  for (const r of ranges) {
    out.push(original.slice(cursor, r.start));
    out.push(r.newText);
    cursor = r.end;
  }
  out.push(original.slice(cursor));
  return out.join("");
}
