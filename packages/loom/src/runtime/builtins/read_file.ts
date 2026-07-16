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
  canonicalizeForGrant,
  canonicalizeRoots,
  describePaths,
  pathAllowed,
  pathGrantContains,
  paths,
  resolvedPaths,
  samplePathGrant,
} from "./_path.js";

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

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
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
    this.description =
      `Read a UTF-8 file from disk (${describePaths(this.granted, this.fromDefault)}). ` +
      `Image files (png/jpeg/gif/webp, up to 5 MiB) are returned as viewable images.`;
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
    const { path: requested } = input as ReadFileInput;
    const target = await canonicalizeForGrant(path.resolve(requested), "read");
    const allowed = await canonicalizeRoots(this.granted);
    if (!pathAllowed(target, allowed)) {
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

    const imageMime = IMAGE_MIME_BY_EXT[path.extname(target).toLowerCase()];
    if (imageMime) {
      // Images bypass the client's readTextFile (it would mangle the bytes);
      // the model gets a real image block instead of binary-as-UTF8 garbage.
      try {
        const stat = await fs.stat(target);
        if (stat.size > MAX_IMAGE_BYTES) {
          return {
            content:
              `read_file: '${path.basename(target)}' is a ` +
              `${humanSize(stat.size)} image; images over 5 MiB can't be attached`,
            isError: true,
            display,
          };
        }
        const buf = await fs.readFile(target);
        return {
          content: [
            {
              type: "image",
              data: buf.toString("base64"),
              mimeType: imageMime,
            },
          ],
          display,
        };
      } catch (e) {
        return {
          content: `read_file: ${(e as Error).message}`,
          isError: true,
          display,
        };
      }
    }

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
