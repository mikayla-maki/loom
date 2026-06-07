import * as fs from "node:fs/promises";
import * as path from "node:path";

import { expandHome } from "../../internal/util.js";
import { defaultContains, grantRows } from "../../manifest/capabilities.js";
import type { CapabilityGrant, CapabilitySet } from "../../types/manifest.js";

export function paths(grant: CapabilitySet | undefined): "*" | string[] | null {
  if (grant === undefined) return null;
  if (grant === "*") return "*";
  const rows = grantRows(grant) as CapabilityGrant[];
  let anyRowDeclaresPaths = false;
  const collected: string[] = [];
  for (const row of rows) {
    const value = row.paths;
    if (value === undefined) continue;
    if (value === "*") return "*";
    if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
      throw new Error('capability `paths` must be "*" or an array of strings');
    }
    anyRowDeclaresPaths = true;
    for (const p of value as string[]) {
      // Expand `~/` before resolve; resolve treats `~` as a literal segment.
      collected.push(path.resolve(expandHome(p)));
    }
  }
  if (!anyRowDeclaresPaths) return null;
  return [...new Set(collected)];
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

// Resolve symlinks BEFORE the lexical `pathAllowed` check — these tools have
// no OS sandbox, so a symlink inside a granted dir would otherwise escape the
// allowlist. (The sandbox modules realpath their binds for the same reason.)
// For writes the target may not exist yet, so canonicalize the nearest
// existing ancestor and re-join the tail.
export async function canonicalizeForGrant(
  target: string,
  mode: "read" | "write",
): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    if (mode === "read") return target;
  }
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

// Granted roots get the same realpath treatment so the prefix check compares
// realpath-vs-realpath (on macOS `/tmp` and `/var` are symlinks into
// `/private`). Unresolvable roots keep their lexical form.
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

export function isUnderOrEqual(target: string, root: string): boolean {
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

// `Tool.containsGrant` for the path-based builtins. Strict containment: a kind
// absent from a superset row authorizes nothing, and `paths` compare lexically
// (equal-to or under a superset root) rather than by set membership.
export function pathGrantContains(
  superset: CapabilitySet | undefined,
  subset: CapabilitySet | undefined,
): boolean {
  if (subset === undefined) return true;
  if (superset === "*") return true;
  if (subset === "*") return false;
  if (superset === undefined) return isEmptyGrant(subset);
  const supersetRows = grantRows(superset) as CapabilityGrant[];
  const subsetRows = grantRows(subset) as CapabilityGrant[];
  return subsetRows.every((subsetRow) =>
    supersetRows.some((supersetRow) => rowContains(supersetRow, subsetRow)),
  );
}

function isEmptyGrant(grant: CapabilitySet): boolean {
  if (grant === "*") return false;
  const rows = grantRows(grant) as CapabilityGrant[];
  return rows.every((row) =>
    Object.keys(row).every((kind) => row[kind] === undefined),
  );
}

function rowContains(
  supersetRow: CapabilityGrant,
  subsetRow: CapabilityGrant,
): boolean {
  for (const kind of Object.keys(subsetRow)) {
    const subsetValue = subsetRow[kind];
    if (subsetValue === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(supersetRow, kind)) return false;
    const supersetValue = supersetRow[kind];
    if (kind === "paths") {
      if (!pathValueContains(supersetValue, subsetValue)) return false;
    } else if (!defaultContains(supersetValue, subsetValue)) {
      return false;
    }
  }
  return true;
}

function pathValueContains(
  supersetValue: unknown,
  subsetValue: unknown,
): boolean {
  if (subsetValue === undefined) return true;
  if (supersetValue === "*") return true;
  if (subsetValue === "*") return false;
  if (!isStringArray(supersetValue) || !isStringArray(subsetValue)) {
    return defaultContains(supersetValue, subsetValue);
  }
  const supersetRoots = supersetValue.map((p) => path.resolve(expandHome(p)));
  return subsetValue
    .map((p) => path.resolve(expandHome(p)))
    .every((target) => isUnderAny(target, supersetRoots));
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
