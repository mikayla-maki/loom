/**
 * Small internal-only helpers. Not re-exported from `src/index.ts`;
 * these exist purely to keep call sites legible.
 */

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
