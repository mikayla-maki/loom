import * as fs from "node:fs/promises";
import * as path from "node:path";

import { expandHome } from "../../internal/util.js";
import type { CapabilitySet } from "../../types/manifest.js";
import type { ToolContext, TrustedPath } from "../../types/interfaces.js";

export function paths(grant: CapabilitySet | undefined): "*" | string[] | null {
  if (grant === undefined) return null;
  if (grant === "*") return "*";
  const v = grant.paths;
  if (v === undefined) return null;
  if (v === "*") return "*";
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    // Expand `~/` before resolve; resolve treats `~` as a literal segment.
    return (v as string[]).map((p) => path.resolve(expandHome(p)));
  }
  throw new Error('capability `paths` must be "*" or an array of strings');
}

export function defaultPaths(): string[] {
  return [path.resolve(".")];
}

export function resolvedPaths(
  grant: CapabilitySet | undefined,
): "*" | string[] {
  const explicit = paths(grant);
  return explicit ?? defaultPaths();
}

// Resolve symlinks to a real path BEFORE the lexical `pathAllowed` check.
// Without this, a symlink inside a granted dir points outside the allowlist
// and fs.readFile/writeFile follow it out — these tools have no OS sandbox.
// (The sandbox modules realpath their binds for the same reason.)
//
// For `read`, canonicalize the target itself. For `write`, the file (or its
// parent dirs, with create_dirs) may not exist yet, so canonicalize the nearest
// existing ancestor (catching a symlinked parent) and re-join the remaining
// not-yet-created segments. A path with no resolvable ancestor falls through to
// its lexical form, preserving the existing not-found/error behavior.
export async function canonicalizeForGrant(
  target: string,
  mode: "read" | "write",
): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    if (mode === "read") return target;
  }
  // Walk up to the nearest ancestor that exists, then re-attach the tail.
  const tail: string[] = [];
  let dir = target;
  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir) return target; // reached the root without resolving
    tail.unshift(path.basename(dir));
    try {
      return path.join(await fs.realpath(parent), ...tail);
    } catch {
      dir = parent;
    }
  }
}

// Canonicalize the granted roots to match `canonicalizeForGrant`'s target, so
// the prefix check compares realpath-vs-realpath (e.g. on macOS `/tmp` and
// `/var` are symlinks into `/private`). Non-existent or unresolvable roots keep
// their lexical form.
export async function canonicalizeRoots(
  granted: "*" | string[],
): Promise<"*" | string[]> {
  if (granted === "*") return granted;
  return await Promise.all(
    granted.map(async (root) => {
      try {
        return await fs.realpath(root);
      } catch {
        return root;
      }
    }),
  );
}

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

function isUnderOrEqual(target: string, root: string): boolean {
  if (target === root) return true;
  return target.startsWith(root + path.sep);
}

export function describePaths(
  granted: "*" | string[],
  fromDefault = false,
): string {
  const tag = fromDefault ? " [smart default]" : "";
  if (granted === "*") return `unrestricted filesystem${tag}`;
  if (granted.length === 0) return "no filesystem access";
  return `restricted to: ${granted.join(", ")}${tag}`;
}

export function filterTrustedPaths(
  trusted: readonly TrustedPath[],
  needs: "read" | "write",
): TrustedPath[] {
  if (needs === "read") return [...trusted];
  return trusted.filter(
    (t) => t.access === "write" || t.access === "read-write",
  );
}

export function effectivePaths(
  granted: "*" | string[],
  trusted: readonly TrustedPath[],
  needs: "read" | "write",
): "*" | string[] {
  if (granted === "*") return "*";
  const accepted = filterTrustedPaths(trusted, needs);
  if (accepted.length === 0) return granted;
  const extras = accepted.map((t) => path.resolve(expandHome(t.path)));
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

export async function collectTrustedPaths(
  ctx: ToolContext,
): Promise<TrustedPath[]> {
  const session = ctx.agent?.session;
  if (!session || typeof session.trustedPaths !== "function") return [];
  try {
    return (await Promise.resolve(session.trustedPaths())) ?? [];
  } catch {
    return [];
  }
}
