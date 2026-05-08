/**
 * Manifest "resolution" — what's left of it.
 *
 * Tools are constructed by providers; the capability check lives in
 * `manifest/capabilities.ts`. Loom's job in here is now just
 * `resolveSystemPrompt`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ResolutionError } from "../errors.js";
import type { AgentManifest } from "../types/manifest.js";

/**
 * Read `[agent].system_prompt` and return its text. The string form is
 * disambiguated by prefix (`./`, `../`, `/`, `~/` → path; otherwise
 * literal); the structured form `{ path }` is unambiguous and accepted
 * even when the literal would be path-shaped.
 */
export async function resolveSystemPrompt(
  manifest: AgentManifest,
  baseDir: string,
): Promise<string> {
  const v = manifest.systemPrompt;
  if (v === undefined) return "";
  if (typeof v === "object") {
    const p = path.resolve(baseDir, expandHome(v.path));
    return await readSystemPromptFile(p);
  }
  if (looksLikePromptPath(v)) {
    const p = path.resolve(baseDir, expandHome(v));
    return await readSystemPromptFile(p);
  }
  return v;
}

async function readSystemPromptFile(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (e) {
    throw new ResolutionError(
      `Failed to read [agent].system_prompt file at ${p}: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

function looksLikePromptPath(s: string): boolean {
  return (
    s.startsWith("./") ||
    s.startsWith("../") ||
    s.startsWith("/") ||
    s.startsWith("~/")
  );
}

function expandHome(p: string): string {
  if (!p.startsWith("~/")) return p;
  return path.join(process.env.HOME ?? "", p.slice(2));
}
