/**
 * Shared path utilities for filesystem-shaped tools (read_file,
 * write_file, find).
 *
 * The capability kind is `paths`. Star/list/absent semantics:
 *   absent      → tool's smart default (each tool decides; FS tools
 *                 fall back to `["./"]`, the project root)
 *   `"*"`       → unrestricted
 *   `[]`        → explicit no-access (every call fails)
 *   `["./..."]` → allowlist of absolute path roots
 *
 * Both grant and target are normalised to absolute paths; `./` is
 * resolved against `process.cwd()` at boot time.
 */

import * as path from "node:path";

import type { CapabilitySet } from "../../types/manifest.js";

/**
 * Read the `paths` grant from a tool's CapabilitySet.
 * Returns:
 *   - `"*"`            — unrestricted (whole-tool `"*"` or kind `"*"`)
 *   - `string[]`       — absolute-path allowlist (may be empty;
 *                        empty means "no access", explicit)
 *   - `null`           — kind is absent from the grant; caller should
 *                        substitute its smart default
 *
 * Throws if the value shape isn't `"*"` or a string array.
 */
export function paths(grant: CapabilitySet | undefined): "*" | string[] | null {
  if (grant === undefined) return null;
  if (grant === "*") return "*";
  const v = grant.paths;
  if (v === undefined) return null;
  if (v === "*") return "*";
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return (v as string[]).map((p) => path.resolve(p));
  }
  throw new Error('capability `paths` must be "*" or an array of strings');
}

/**
 * Default `paths` grant FS tools use when the manifest doesn't grant
 * the kind. The project root — the cwd at boot time — is the
 * pragmatic safe default: a tool that does nothing on every call
 * would be surprising, and "./" matches what a person running an
 * agent in their project usually means.
 */
export function defaultPaths(): string[] {
  return [path.resolve(".")];
}

/**
 * Resolve a `paths` grant into the granted set the tool actually uses,
 * substituting the smart default when absent. Returns `"*"` or a
 * concrete (possibly empty) string array — never `null`.
 */
export function resolvedPaths(
  grant: CapabilitySet | undefined,
): "*" | string[] {
  const explicit = paths(grant);
  return explicit ?? defaultPaths();
}

/**
 * Whether `target` (absolute) is contained by the granted paths.
 *
 * Matching is **always prefix-by-segment**: each grant entry covers
 * itself and everything beneath it. Because a file path on a real
 * filesystem cannot have any path appended (`/proj/foo.txt/extra`
 * isn't reachable), the same rule degrades to exact-match for
 * file-shaped grants and prefix-match for folder-shaped grants —
 * which is the intuitive behavior in both cases.
 */
export function pathAllowed(target: string, granted: "*" | string[]): boolean {
  if (granted === "*") return true;
  for (const root of granted) {
    if (isUnderOrEqual(target, root)) return true;
  }
  return false;
}

export function isUnderAny(target: string, roots: string[]): boolean {
  for (const root of roots) {
    if (isUnderOrEqual(target, root)) return true;
  }
  return false;
}

/** Prefix-by-segment containment. Equality counts; `/foo` doesn't contain `/foobar`. */
function isUnderOrEqual(target: string, root: string): boolean {
  if (target === root) return true;
  return target.startsWith(root + path.sep);
}

/**
 * Pretty-print a `paths` grant for tool descriptions. Adds a
 * `(default)` annotation when the grant came from the smart default
 * rather than the manifest.
 */
export function describePaths(
  granted: "*" | string[],
  fromDefault = false,
): string {
  const tag = fromDefault ? " [smart default]" : "";
  if (granted === "*") return `unrestricted filesystem${tag}`;
  if (granted.length === 0) return "no filesystem access";
  return `restricted to: ${granted.join(", ")}${tag}`;
}
