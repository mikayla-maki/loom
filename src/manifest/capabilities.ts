/**
 * Capability containment — checks each tool's declared `capabilities`
 * against the matching `[capabilities.<name>]` ceiling entry, when one
 * is present.
 *
 * Loom doesn't interpret capability shapes — they're tool-defined. The
 * `defaultContains` function here is a structural deep-subset check
 * that handles the common case (objects with string-array values).
 * Tools with richer semantics (path-prefix matching, IP ranges, etc.)
 * implement `Tool.capabilitiesContain` to override.
 */

import { CapabilityError } from "../errors.js";
import type { Tool } from "../types/interfaces.js";
import type { Capabilities } from "../types/manifest.js";

/**
 * Assert each tool's declared `capabilities` fits inside the matching
 * `[capabilities.<tool-name>]` ceiling entry. Tools without a matching
 * ceiling entry pass unconditionally (no extra check). Tools with no
 * declared `capabilities` also pass.
 *
 * The containment check is the tool's own `capabilitiesContain` if it
 * has one, otherwise the structural `defaultContains` below.
 */
export function assertCapabilities(
  tools: Map<string, Tool>,
  ceiling: Capabilities,
): void {
  const violations: Array<{
    tool: string;
    declared: unknown;
    ceiling: unknown;
  }> = [];
  for (const [name, tool] of tools) {
    if (!(name in ceiling)) continue;
    if (tool.capabilities === undefined) continue;
    const entry = ceiling[name];
    const ok = tool.capabilitiesContain
      ? tool.capabilitiesContain(entry, tool.capabilities)
      : defaultContains(entry, tool.capabilities);
    if (!ok) {
      violations.push({
        tool: name,
        declared: tool.capabilities,
        ceiling: entry,
      });
    }
  }
  if (violations.length > 0) {
    const summary = violations
      .map(
        (v) =>
          `  - ${v.tool}: declared ${JSON.stringify(v.declared)} exceeds ceiling ${JSON.stringify(v.ceiling)}`,
      )
      .join("\n");
    throw new CapabilityError(
      `Tool capabilities exceed the agent's [capabilities] ceiling:\n${summary}`,
      Object.fromEntries(violations.map((v) => [v.tool, v.declared])),
      Object.fromEntries(violations.map((v) => [v.tool, v.ceiling])),
    );
  }
}

/**
 * Structural deep-subset check.
 *
 *   - Arrays: subset's items must all appear in superset (string
 *     equality; superset can have extras).
 *   - Plain objects: every key in subset must exist in superset, with
 *     `defaultContains(superset[k], subset[k])` recursively.
 *   - Primitives (string, number, boolean): deep-equal.
 *   - `undefined` superset is treated as "unconstrained" and contains
 *     anything; `undefined` subset is contained by anything.
 */
export function defaultContains(superset: unknown, subset: unknown): boolean {
  if (subset === undefined) return true;
  if (superset === undefined) return true;
  if (Array.isArray(superset) && Array.isArray(subset)) {
    const sup = new Set(superset.map((x) => JSON.stringify(x)));
    return subset.every((x) => sup.has(JSON.stringify(x)));
  }
  if (
    typeof superset === "object" &&
    superset !== null &&
    typeof subset === "object" &&
    subset !== null &&
    !Array.isArray(superset) &&
    !Array.isArray(subset)
  ) {
    const sup = superset as Record<string, unknown>;
    const sub = subset as Record<string, unknown>;
    for (const k of Object.keys(sub)) {
      if (!defaultContains(sup[k], sub[k])) return false;
    }
    return true;
  }
  return JSON.stringify(superset) === JSON.stringify(subset);
}
