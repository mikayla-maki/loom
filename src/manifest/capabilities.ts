/**
 * Capability validation — does the union of tool-required capabilities fit
 * inside the agent's [sandbox] ceiling?
 *
 * The runtime calls this before booting an agent. If it fails, the agent
 * does not start.
 */

import { CapabilityError } from "../errors.js";
import type { Capabilities } from "../types/manifest.js";

export interface CapabilityField {
  /** Items in `required` not in `ceiling`, when literal-membership is used. */
  excess: string[];
}

/** The four capability axes Glass tracks at v0/v1. */
export type CapabilityAxis = "filesystem" | "network" | "secrets" | "subagent";

const AXES: CapabilityAxis[] = ["filesystem", "network", "secrets", "subagent"];

/**
 * Union all capabilities from a list of contributors (e.g. tools).
 *
 * For string-array axes we just merge & dedupe. The "*" wildcard on subagent
 * is preserved (means "any declared by skills").
 */
export function unionCapabilities(parts: Array<Capabilities | undefined>): Capabilities {
  const out: Capabilities = {};
  for (const p of parts) {
    if (!p) continue;
    for (const axis of AXES) {
      const v = p[axis as keyof Capabilities];
      if (v === undefined) continue;
      if (v === "*") {
        if (axis === "subagent") out.subagent = "*";
        continue;
      }
      const cur = out[axis];
      if (cur === "*") continue;
      const arr = (cur as string[] | undefined) ?? [];
      const merged = new Set<string>(arr);
      for (const x of v as string[]) merged.add(x);
      if (axis === "subagent") out.subagent = Array.from(merged);
      else if (axis === "filesystem") out.filesystem = Array.from(merged);
      else if (axis === "network") out.network = Array.from(merged);
      else if (axis === "secrets") out.secrets = Array.from(merged);
    }
  }
  return out;
}

/**
 * Assert that `required` ⊆ `ceiling`.
 *
 * Rules per axis:
 *  - filesystem: each required path must be inside *some* ceiling path
 *    (path-prefix containment).
 *  - network: each required host must match a ceiling entry, where ceiling
 *    entries may be wildcards like `*.example.com`.
 *  - secrets, subagent: literal set membership.
 *
 * If `ceiling.subagent === "*"` the subagent axis is unrestricted.
 */
export function assertSubset(required: Capabilities, ceiling: Capabilities): void {
  const violations: Record<string, string[]> = {};

  // filesystem
  if (required.filesystem && required.filesystem.length > 0) {
    const c = ceiling.filesystem ?? [];
    const bad = required.filesystem.filter((req) => !pathContainedInAny(req, c));
    if (bad.length > 0) violations.filesystem = bad;
  }

  // network
  if (required.network && required.network.length > 0) {
    const c = ceiling.network ?? [];
    const bad = required.network.filter((req) => !hostMatchesAny(req, c));
    if (bad.length > 0) violations.network = bad;
  }

  // secrets
  if (required.secrets && required.secrets.length > 0) {
    const c = new Set(ceiling.secrets ?? []);
    const bad = required.secrets.filter((s) => !c.has(s));
    if (bad.length > 0) violations.secrets = bad;
  }

  // subagent
  if (required.subagent && required.subagent !== "*") {
    if (ceiling.subagent !== "*") {
      const c = new Set(ceiling.subagent ?? []);
      const bad = (required.subagent as string[]).filter((s) => !c.has(s));
      if (bad.length > 0) violations.subagent = bad;
    }
  } else if (required.subagent === "*" && ceiling.subagent !== "*") {
    violations.subagent = ["* (unrestricted) requires ceiling subagent = \"*\""];
  }

  if (Object.keys(violations).length > 0) {
    const summary = Object.entries(violations)
      .map(([axis, items]) => `  - ${axis}: ${items.join(", ")}`)
      .join("\n");
    throw new CapabilityError(
      `Tool-required capabilities exceed the agent's [sandbox] ceiling:\n${summary}`,
      required as unknown as Record<string, unknown>,
      ceiling as unknown as Record<string, unknown>,
    );
  }
}

function pathContainedInAny(req: string, ceilings: string[]): boolean {
  // Normalize trailing slashes; treat ceiling "./foo" as "covers everything under foo".
  const normReq = normalizeRel(req);
  for (const c of ceilings) {
    const normC = normalizeRel(c);
    if (normReq === normC) return true;
    if (normC === "" || normC === ".") return true; // ceiling = root
    if (normReq.startsWith(normC + "/")) return true;
  }
  return false;
}

function normalizeRel(p: string): string {
  let s = p;
  if (s.startsWith("./")) s = s.slice(2);
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function hostMatchesAny(req: string, ceilings: string[]): boolean {
  for (const c of ceilings) {
    if (c === req) return true;
    if (c === "*") return true;
    if (c.startsWith("*.")) {
      const suffix = c.slice(1); // ".example.com"
      if (req === suffix.slice(1)) return true; // exact apex match
      if (req.endsWith(suffix)) return true;
    }
  }
  return false;
}
