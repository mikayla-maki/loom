/**
 * Tiny type-narrowing helpers for vitest tests.
 *
 * `noUncheckedIndexedAccess` makes array / Map / Record index access
 * return `T | undefined`. Sprinkling `!` everywhere works, but trips
 * the `no-non-null-assertion` rule. These helpers do the narrowing
 * via a real runtime check so the test fails with a useful message
 * if an invariant is violated, while keeping the call sites compact.
 */

/**
 * Asserts the value is not `undefined` (or `null`), narrowing `v` to
 * `T` for the rest of the scope. Use when you want to keep referring
 * to the original expression:
 *
 * ```ts
 * assertDefined(arr[0]);
 * arr[0].foo; // ← narrowed
 * ```
 */
export function assertDefined<T>(
  v: T | undefined | null,
  msg?: string,
): asserts v is T {
  if (v === undefined || v === null) {
    throw new Error(msg ?? "expected value to be defined");
  }
}

/**
 * Returns the value if defined, otherwise throws. Convenient when
 * you'd rather capture the narrowed value into a const:
 *
 * ```ts
 * const first = defined(arr[0]);
 * first.foo;
 * ```
 */
export function defined<T>(v: T | undefined | null, msg?: string): T {
  if (v === undefined || v === null) {
    throw new Error(msg ?? "expected value to be defined");
  }
  return v;
}
