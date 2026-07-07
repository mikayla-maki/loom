import { constants as fsConstants } from "node:fs";
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

// Raised when a write target defeats the lexical allowlist by aliasing a file
// outside the grant (a terminal symlink or a hard link). Callers surface the
// message and mark the result as an error.
export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSecurityError";
  }
}

// A write target opened WITHOUT following a terminal symlink and verified not
// to be a hard-link alias. Callers write THROUGH `handle` (never by path
// again), so no symlink can be raced into place between the check and the
// write. `existed` reports whether the file was already present, for the
// create-vs-overwrite diff label.
export interface SafeWriteHandle {
  handle: fs.FileHandle;
  existed: boolean;
}

function symlinkRefusal(target: string): PathSecurityError {
  return new PathSecurityError(
    `refusing to write through a symlink ('${target}'): the granted path ` +
      `allowlist is enforced on the link itself, not on the file it points ` +
      `to, so following it could escape the grant`,
  );
}

function hardLinkRefusal(target: string, nlink: number): PathSecurityError {
  return new PathSecurityError(
    `refusing to write to '${target}': it is a hard link (link count ` +
      `${nlink}) and may alias a file outside the granted paths. Write to a ` +
      `fresh path instead`,
  );
}

// `realpath` resolves symlinks, so `canonicalizeForGrant` already rejects a
// write whose final component is a symlink pointing at an *existing* file
// outside the grant. Two escapes slip past it, which this closes:
//
//   * A DANGLING terminal symlink (or one whose target doesn't exist yet):
//     `realpath` fails, the fallback re-joins the tail onto the in-grant
//     ancestor, the lexical check passes, and a path-based write then follows
//     the link out of the grant. Also covers the check-then-write RACE where a
//     symlink is swapped in after the allowlist check. `O_NOFOLLOW` makes the
//     open fail (ELOOP) rather than follow a terminal symlink, and the write
//     goes through the returned fd, so there is no second path lookup to race.
//
//   * A HARD LINK inside the grant aliasing an inode that also lives outside
//     it. `realpath` sees only an in-grant name; the link count from `fstat`
//     is the only tell, so regular files with nlink > 1 are refused.
export async function openWriteNoFollow(
  target: string,
  opts: { append: boolean; create: boolean },
): Promise<SafeWriteHandle> {
  // Prior existence (for the diff label) plus an early, precise symlink reject.
  // The authoritative symlink defense is O_NOFOLLOW below.
  let existed = true;
  try {
    const pre = await fs.lstat(target);
    if (pre.isSymbolicLink()) throw symlinkRefusal(target);
  } catch (e) {
    if (e instanceof PathSecurityError) throw e;
    if ((e as NodeJS.ErrnoException).code === "ENOENT") existed = false;
    else throw e;
  }

  // O_RDWR (not O_WRONLY) so prior content can be read back through this same
  // fd for the diff, race-free, without a second path lookup.
  let flags = fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0);
  if (opts.append) flags |= fsConstants.O_APPEND;
  if (opts.create) flags |= fsConstants.O_CREAT;

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(target, flags, 0o644);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw symlinkRefusal(target);
    throw e;
  }

  try {
    const st = await handle.stat();
    if (st.isFile() && st.nlink > 1) throw hardLinkRefusal(target, st.nlink);
  } catch (e) {
    await handle.close();
    throw e;
  }

  return { handle, existed };
}

// Best-effort guard for the ACP-client write path, which writes by PATH on the
// editor side, so we cannot hand it a fd. Rejects the same terminal-symlink and
// hard-link escapes via an lstat. A residual check-then-write race is inherent
// to delegating by path and is bounded by the editor being a trusted local
// component; the fd-based `openWriteNoFollow` is used whenever we write
// ourselves.
export async function assertSafeWriteTarget(target: string): Promise<void> {
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    st = await fs.lstat(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (st.isSymbolicLink()) throw symlinkRefusal(target);
  if (st.isFile() && st.nlink > 1) throw hardLinkRefusal(target, st.nlink);
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

// Valid-grant generator shared by the path-based builtins for the capability
// algebra conformance checker (audit/tests only). The generic structural
// generator emits unrelated tokens that never share a prefix, so it can't
// exercise the lexical containment in `pathValueContains` (e.g. `./` ⊃
// `./src`). Drawing from a pool of nested prefixes makes those relationships
// occur, stressing the real path algebra.
export function samplePathGrant(random: () => number): CapabilitySet {
  const dirs = ["./", "./src", "./src/deep", "~/.config", "/tmp", "/tmp/sub"];
  const pick = (xs: readonly string[]): string =>
    xs[Math.floor(random() * xs.length)] as string;
  const subset = (xs: readonly string[]): string[] => {
    const out = xs.filter(() => random() < 0.5);
    return out.length > 0 ? out : [pick(xs)];
  };
  const row = (): CapabilityGrant =>
    random() < 0.2 ? {} : { paths: random() < 0.3 ? "*" : subset(dirs) };
  const shape = random();
  if (shape < 0.12) return "*";
  if (shape < 0.2) return {};
  if (shape < 0.6) return row();
  const n = 1 + Math.floor(random() * 3);
  return Array.from({ length: n }, row);
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
