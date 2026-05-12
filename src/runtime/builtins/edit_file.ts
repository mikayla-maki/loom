/**
 * `edit_file` — modify an existing UTF-8 file by exact text
 * replacement. Designed for incremental, model-driven edits where
 * sending the full file every time is wasteful.
 *
 * The model passes one or more `{ old_text, new_text }` pairs. Each
 * `old_text` MUST match a unique substring of the file's current
 * content; all replacements apply against the *original* file (not
 * incrementally), so the model never has to reason about how earlier
 * edits shifted positions. Overlapping or nested matches are
 * rejected.
 *
 * Capability kinds:
 *   optional: ["paths"]
 *
 * Star/list/absent semantics: same as `write_file`/`read_file` —
 *   paths absent  → smart default `["./"]` (project root)
 *   paths = "*"   → unrestricted
 *   paths = []    → explicit no-access (every call fails)
 *   paths = [...] → allowlist of absolute path roots
 *
 * The file MUST already exist. To create a new file, use `write_file`.
 */

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
  collectTrustedPaths,
  describePaths,
  effectivePaths,
  pathAllowed,
  paths,
  resolvedPaths,
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

  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const i = input as EditFileInput;
    const target = path.resolve(i.path);

    const trusted = await collectTrustedPaths(ctx);
    const effective = effectivePaths(this.granted, trusted, "write");
    if (!pathAllowed(target, effective)) {
      return {
        content: `edit_file: '${i.path}' is outside the granted paths (${describePaths(this.granted, this.fromDefault)})`,
        isError: true,
      };
    }

    // Read the current file content. Route through the ACP client
    // when available so the agent sees the same buffer the editor
    // has in front of the user (including unsaved changes).
    let oldContent: string;
    try {
      if (ctx.client?.readTextFile) {
        oldContent = await ctx.client.readTextFile({ path: target });
      } else {
        oldContent = await fs.readFile(target, "utf8");
      }
    } catch (e) {
      return {
        content: `edit_file: ${(e as Error).message}. Use write_file to create new files.`,
        isError: true,
      };
    }

    // Apply edits against the ORIGINAL content. Each match is computed
    // against `oldContent`; assembly is a single left-to-right pass
    // so we never feed an earlier edit's output into a later edit's
    // matcher.
    let newContent: string;
    try {
      newContent = applyEdits(oldContent, i.edits);
    } catch (e) {
      return {
        content: `edit_file: ${(e as Error).message}`,
        isError: true,
      };
    }

    // Write the result back. Same routing as the read.
    try {
      if (ctx.client?.writeTextFile) {
        await ctx.client.writeTextFile({ path: target, content: newContent });
      } else {
        await fs.writeFile(target, newContent, "utf8");
      }
    } catch (e) {
      return {
        content: `edit_file: ${(e as Error).message}`,
        isError: true,
      };
    }

    // ACP `Diff` content block lets the client render a real diff
    // view. We hand over the full before/after; the client owns the
    // visual layout.
    const diff: ToolCallContent = {
      type: "diff",
      path: target,
      oldText: oldContent,
      newText: newContent,
    };
    const display: ToolDisplay = {
      title: `Edited ${path.basename(target)} (${i.edits.length} block${i.edits.length === 1 ? "" : "s"})`,
      kind: "edit",
      locations: [{ path: target }],
      content: [diff],
    };

    return {
      content: `Replaced ${i.edits.length} block${i.edits.length === 1 ? "" : "s"} in ${i.path}.`,
      display,
    };
  }
}

/**
 * Apply each `{ old_text, new_text }` edit to `original`. Throws on
 * any of: empty `edits`, an `old_text` not found, an `old_text`
 * matching multiple times (ambiguous), or overlapping match ranges.
 * All matches are computed against `original`, not after prior edits
 * — the order of entries doesn't change the result.
 *
 * Exported for unit-test convenience.
 */
export function applyEdits(
  original: string,
  edits: ReadonlyArray<{ old_text: string; new_text: string }>,
): string {
  if (edits.length === 0) {
    throw new Error("no edits provided");
  }

  // Compute each edit's match range in the original content.
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

  // Sort by start position; verify non-overlap.
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

  // Stitch the new content together: unchanged spans + replacements,
  // in original-order. Because we process ranges left-to-right, each
  // `cursor` advance is monotonic and we never re-read replaced text.
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
