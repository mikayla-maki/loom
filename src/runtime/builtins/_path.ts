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
import type { ToolContext, TrustedPath } from "../../types/interfaces.js";

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

/**
 * Filter `trustedPaths` to entries that admit the access this tool
 * needs. Read-oriented tools accept any access level (a write grant
 * implies the ability to read); write-oriented tools require `"write"`
 * or `"read-write"`.
 */
export function filterTrustedPaths(
  trusted: readonly TrustedPath[],
  needs: "read" | "write",
): TrustedPath[] {
  if (needs === "read") return [...trusted];
  return trusted.filter(
    (t) => t.access === "write" || t.access === "read-write",
  );
}

/**
 * Compute the effective path set for a tool call: the manifest's grant
 * unioned with the session-declared trusted paths the access semantics
 * admit. Returns `"*"` unchanged (already unrestricted) — the union is
 * only relevant for concrete allowlists.
 *
 * Path-aware tools call this at execute time (not at construction)
 * because a session's `trustedPaths()` can change between turns (a
 * skills session, for instance, may pick up newly-added skills on
 * each `prepareTurn`). The trusted paths are resolved to absolute via
 * `path.resolve` for consistent prefix matching.
 */
export function effectivePaths(
  granted: "*" | string[],
  trusted: readonly TrustedPath[],
  needs: "read" | "write",
): "*" | string[] {
  if (granted === "*") return "*";
  const accepted = filterTrustedPaths(trusted, needs);
  if (accepted.length === 0) return granted;
  const extras = accepted.map((t) => path.resolve(t.path));
  // Dedup against existing grants (cheap; small N in practice).
  const seen = new Set(granted);
  const out = [...granted];
  for (const p of extras) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * Best-effort retrieval of `Session.trustedPaths()` from the tool's
 * `ctx.agent`. Sessions that don't implement the method, throw, or
 * are absent are treated as contributing nothing — a path-aware tool
 * should still function with just its manifest grant.
 *
 * Cheap to call per dispatch: skills/file/memory sessions all keep an
 * in-memory cache or trivial state; the I/O happens in `prepareTurn`.
 */
export async function collectTrustedPaths(
  ctx: ToolContext,
): Promise<TrustedPath[]> {
  const session = ctx.agent?.session;
  if (!session || typeof session.trustedPaths !== "function") return [];
  try {
    return (await Promise.resolve(session.trustedPaths())) ?? [];
  } catch {
    // Sessions that misbehave shouldn't crash tool execution; the
    // tool falls back to its static grant.
    return [];
  }
}
