import seedrandom from "seedrandom";

import { defaultContains, defaultMerge } from "./capabilities.js";
import type { Tool } from "../types/interfaces.js";
import type { CapabilitySet } from "../types/manifest.js";

// A tool's capability algebra (`containsGrant` / `mergeGrants`) is trusted to
// be honest, but honesty isn't enough: the ceiling guarantee ("an agent never
// runs with authority outside `[capabilities]`") only holds if that algebra is
// a well-formed join-semilattice. Those laws are black-box testable — unlike
// "is this provider malicious" — so we can turn "trust the author got the math
// right" into a checked precondition. This catches the realistic honest-author
// bugs (flattening the structure, returning a non-upper-bound merge, a
// non-transitive contains, a forgotten kind) without needing a value schema:
// generic structural grants over the tool's declared kinds suffice.

export interface AlgebraViolation {
  // Stable identifier for the broken law, e.g. "merge-upper-bound".
  law: string;
  message: string;
}

export interface AlgebraCheckOptions {
  // Capability kinds to build grants from. Defaults to the tool's
  // `requires` ∪ `optional`.
  kinds?: readonly string[];
  // Size of the random grant pool. Default 64.
  samples?: number;
  // Random triples drawn from the pool to exercise the binary/ternary laws.
  // Default 600.
  trials?: number;
  // Seed for reproducibility. Default 1.
  seed?: number;
  // Stop collecting after this many violations. Default 20.
  maxViolations?: number;
}

export function checkGrantAlgebra(
  tool: Pick<
    Tool,
    "containsGrant" | "mergeGrants" | "requires" | "optional" | "sampleGrant"
  >,
  options: AlgebraCheckOptions = {},
): AlgebraViolation[] {
  const violations: AlgebraViolation[] = [];
  const max = options.maxViolations ?? 20;
  const add = (law: string, message: string): void => {
    if (violations.length < max) violations.push({ law, message });
  };

  const declared = [...(tool.requires ?? []), ...(tool.optional ?? [])];
  const kinds = options.kinds?.length
    ? [...options.kinds]
    : declared.length > 0
      ? declared
      : ["paths", "network", "env"];

  const rng = seedrandom(String(options.seed ?? 1));
  const contains = (a: CapabilitySet, b: CapabilitySet): boolean => {
    try {
      return tool.containsGrant
        ? tool.containsGrant(a, b)
        : defaultContains(a, b);
    } catch (e) {
      add(
        "contains-total",
        `containsGrant threw on (${j(a)}, ${j(b)}): ${(e as Error).message}`,
      );
      return false;
    }
  };
  const merge = (a: CapabilitySet, b: CapabilitySet): CapabilitySet => {
    try {
      return tool.mergeGrants ? tool.mergeGrants(a, b) : defaultMerge(a, b);
    } catch (e) {
      add(
        "merge-total",
        `mergeGrants threw on (${j(a)}, ${j(b)}): ${(e as Error).message}`,
      );
      return a;
    }
  };
  const equiv = (a: CapabilitySet, b: CapabilitySet): boolean =>
    contains(a, b) && contains(b, a);

  // Prefer the tool's own valid-grant generator when it offers one (better,
  // domain-aware coverage); otherwise synthesize generic structural grants
  // over the declared kinds.
  const sample = tool.sampleGrant
    ? (): CapabilitySet =>
        (tool.sampleGrant as (r: () => number) => CapabilitySet)(rng)
    : (): CapabilitySet => randomGrant(rng, kinds);
  const pool: CapabilitySet[] = [];
  for (let i = 0; i < (options.samples ?? 64); i++) {
    try {
      pool.push(sample());
    } catch (e) {
      add("sample-total", `sampleGrant threw: ${(e as Error).message}`);
      pool.push(randomGrant(rng, kinds));
    }
  }

  // Reflexivity: a grant always contains itself.
  for (const a of pool) {
    if (!contains(a, a))
      add("reflexivity", `contains(a, a) is false: a=${j(a)}`);
  }

  const trials = options.trials ?? 600;
  for (let t = 0; t < trials; t++) {
    const a = pick(rng, pool);
    const b = pick(rng, pool);
    const c = pick(rng, pool);
    const ab = merge(a, b);

    // The safety-coupling law: merge is an upper bound, so the join of
    // ceiling-admitted grants stays under the ceiling.
    if (!contains(ab, a) || !contains(ab, b)) {
      add(
        "merge-upper-bound",
        `merge(a, b) does not contain both inputs: a=${j(a)} b=${j(b)} merge=${j(ab)}`,
      );
    }
    if (!equiv(ab, merge(b, a))) {
      add(
        "merge-commutative",
        `merge(a, b) != merge(b, a): a=${j(a)} b=${j(b)}`,
      );
    }
    const aa = merge(a, a);
    if (!equiv(aa, a)) {
      add("merge-idempotent", `merge(a, a) != a: a=${j(a)} merge=${j(aa)}`);
    }
    if (!equiv(merge(ab, c), merge(a, merge(b, c)))) {
      add(
        "merge-associative",
        `merge(merge(a,b),c) != merge(a,merge(b,c)): a=${j(a)} b=${j(b)} c=${j(c)}`,
      );
    }
    // Least upper bound / no fabricated authority: every piece of merge(a,b)
    // must already be granted by a or b. The upper-bound guard can't see a
    // merge that FLATTENS a row set into a kind-wise bounding box (the box
    // still contains both inputs), but such a merge admits a coupling neither
    // input did — caught here.
    if (!grounded(contains, a, b, ab)) {
      add(
        "merge-least-upper-bound",
        `merge(a,b) admits authority neither input grants (flattening/widening): a=${j(a)} b=${j(b)} merge=${j(ab)}`,
      );
    }
    // Transitivity of the order itself.
    if (contains(a, b) && contains(b, c) && !contains(a, c)) {
      add(
        "transitivity",
        `contains(a,b) and contains(b,c) but not contains(a,c): a=${j(a)} b=${j(b)} c=${j(c)}`,
      );
    }
  }

  return violations;
}

// A tool that overrides the algebra but ships no `sampleGrant` has its custom
// `containsGrant`/`mergeGrants` exercised only by the generic structural
// generator, which never reaches domain-specific shapes (bash's nested path
// prefixes, the `commands` enum-vs-`"*"` distinction, etc.). That's a coverage
// blind spot, not an unsoundness, so it surfaces as an audit warning rather
// than joining the violations the boot gate throws on.
export function customAlgebraWithoutSampler(
  tool: Pick<Tool, "containsGrant" | "mergeGrants" | "sampleGrant">,
): boolean {
  const overridesAlgebra =
    typeof tool.containsGrant === "function" ||
    typeof tool.mergeGrants === "function";
  return overridesAlgebra && typeof tool.sampleGrant !== "function";
}

// Every row of `merged` must be contained in `a` or `b` on its own; a `"*"`
// result is only grounded if an input was already `"*"`. Holds for a true
// union (each row came from an input); fails for a flatten/over-widen.
function grounded(
  contains: (sup: CapabilitySet, sub: CapabilitySet) => boolean,
  a: CapabilitySet,
  b: CapabilitySet,
  merged: CapabilitySet,
): boolean {
  if (merged === "*") return a === "*" || b === "*";
  const rows = Array.isArray(merged) ? merged : [merged];
  return rows.every((row) => contains(a, row) || contains(b, row));
}

function randomGrant(
  rng: () => number,
  kinds: readonly string[],
): CapabilitySet {
  const roll = rng();
  if (roll < 0.08) return "*";
  if (roll < 0.16) return {};
  if (roll < 0.55) return randomRow(rng, kinds);
  const rowCount = 1 + Math.floor(rng() * 3);
  const rows = [];
  for (let i = 0; i < rowCount; i++) rows.push(randomRow(rng, kinds));
  return rows;
}

function randomRow(
  rng: () => number,
  kinds: readonly string[],
): Record<string, CapabilityValueLite> {
  const row: Record<string, CapabilityValueLite> = {};
  for (const kind of kinds) {
    if (rng() < 0.5) continue;
    row[kind] = randomValue(rng);
  }
  return row;
}

type CapabilityValueLite = "*" | string[];

function randomValue(rng: () => number): CapabilityValueLite {
  if (rng() < 0.3) return "*";
  const tokens = ["x", "y", "z"];
  return tokens.filter(() => rng() < 0.5);
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)] as T;
}

function j(x: unknown): string {
  return JSON.stringify(x);
}
