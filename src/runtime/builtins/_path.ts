/**
 * Shared path utilities for filesystem-shaped tools (read_file,
 * write_file, find). Capability shape: `{ paths: string[] }`. Both
 * sides of the contains check are normalized to absolute paths before
 * comparison; "./" in either superset or subset means "the project
 * root" (process.cwd() at boot time).
 */

import * as path from "node:path";

export function normalizePaths(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || !input.every((x) => typeof x === "string")) {
    throw new Error("paths must be an array of strings");
  }
  return (input as string[]).map((p) => path.resolve(p));
}

/**
 * Container check for `{ paths: [...] }`-shaped capabilities. The
 * `superset.paths` (the ceiling) must contain every entry in
 * `subset.paths` (the tool's declared caps), where "contain" means
 * path-prefix containment after both sides are resolved to absolute.
 *
 * Both sides may use relative `./foo` paths; loom normalizes against
 * `process.cwd()`. A ceiling root that contains the tool root is
 * sufficient (e.g. ceiling `["./"]` contains tool `["./src"]`).
 */
export function pathCapsContain(
  superset: unknown,
  subset: unknown,
): boolean {
  const sup = paths(superset);
  const sub = paths(subset);
  for (const s of sub) {
    if (!sup.some((root) => isUnderOrEqual(s, root))) return false;
  }
  return true;
}

export function isUnderAny(target: string, roots: string[]): boolean {
  for (const root of roots) {
    if (isUnderOrEqual(target, root)) return true;
  }
  return false;
}

function isUnderOrEqual(target: string, root: string): boolean {
  if (target === root) return true;
  return target.startsWith(root + path.sep);
}

function paths(v: unknown): string[] {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const obj = v as { paths?: unknown };
    if (obj.paths === undefined) return [];
    if (
      !Array.isArray(obj.paths) ||
      !obj.paths.every((x) => typeof x === "string")
    ) {
      return [];
    }
    return obj.paths.map((p) => path.resolve(p as string));
  }
  return [];
}
