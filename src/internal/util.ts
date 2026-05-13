/**
 * Small internal-only helpers. Not re-exported from `src/index.ts`;
 * these exist purely to keep call sites legible.
 */

import * as os from "node:os";
import * as path from "node:path";

/**
 * Exhaustiveness check for discriminated unions. Place at the end of
 * a `switch` or chain of `if`s over a closed union to turn a missed
 * variant into a compile error.
 *
 *   function describe(s: SourceSpec): string {
 *     if (s === "builtin") return "...";
 *     if ("npm" in s) return "...";
 *     if ("path" in s) return "...";
 *     assertNever(s); // ← compile error if a new variant is added
 *   }
 */
export function assertNever(value: never): never {
  throw new Error(
    `assertNever: unexpected value ${JSON.stringify(value)} (this should be unreachable)`,
  );
}

/**
 * A mutable single-cell holder. Used where two parts of the runtime
 * need to share a value that one of them can swap at runtime — e.g.
 * the permission handler that `RunningAgent.setPermissionHandler`
 * mutates and `RuntimeServicesImpl` reads on every tool dispatch.
 *
 * The shape is intentionally trivial: no React-`useRef` semantics,
 * no reactive subscribers. Just `{ current }`.
 */
export interface Ref<T> {
  current: T;
}

/** Construct a `Ref<T>` with an initial value. */
export function ref<T>(initial: T): Ref<T> {
  return { current: initial };
}

/**
 * Return a shallow copy of `obj` with the `provider` field removed.
 * Replaces the `const { provider: _p, ...config } = obj; void _p;`
 * idiom that otherwise litters the manifest pipeline.
 */
export function stripProvider<T extends { provider?: unknown }>(
  obj: T,
): Omit<T, "provider"> {
  const { provider: _p, ...rest } = obj;
  void _p;
  return rest;
}

/**
 * Expand a leading `~/` (or bare `~`) in a path to the user's home
 * directory. Mirrors what most shells do; centralised here because
 * Loom does it in several places (capability path grants, system-
 * prompt path specs, skills-session root config) and `path.resolve`
 * by itself does NOT honour `~` — it treats the character as a
 * literal relative segment.
 *
 * Uses `os.homedir()` for portability (handles macOS / Linux
 * `$HOME` and Windows `%USERPROFILE%`). When no home directory is
 * available, the path is returned unchanged — callers downstream
 * will fail loudly when they try to use it, which is the right
 * surface for that very-unusual configuration.
 *
 * Examples:
 *   expandHome("~/Dropbox/foo")  →  "/Users/alice/Dropbox/foo"
 *   expandHome("~")              →  "/Users/alice"
 *   expandHome("./local")        →  "./local"        (unchanged)
 *   expandHome("/abs/path")      →  "/abs/path"      (unchanged)
 */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir() || p;
  if (p.startsWith("~/") || p.startsWith("~" + path.sep)) {
    const home = os.homedir();
    if (!home) return p;
    return path.join(home, p.slice(2));
  }
  return p;
}
