/**
 * Capability validation — does the union of tool-required capabilities fit
 * inside the agent's [sandbox] ceiling?
 *
 * The runtime calls this before booting an agent. If it fails, the agent
 * does not start.
 *
 * Permissive-default model: an axis that is *absent* from the ceiling
 * (i.e. `ceiling.filesystem === undefined`) means "no constraint on this
 * axis" (`*`). An empty array means "explicitly nothing." Whole `[sandbox]`
 * absent on the agent therefore means "all axes unconstrained." Subagents
 * are no longer a sandbox axis at the agent level — each skill declares
 * which subagents its tools may invoke; the auditor walks them transitively.
 */

import { CapabilityError } from "../errors.js";
import type { SandboxCeiling, ToolCapabilities } from "../types/manifest.js";

export interface CapabilityField {
  /** Items in `required` not in `ceiling`, when literal-membership is used. */
  excess: string[];
}

/** Capability axes the agent's `[sandbox]` controls. */
export type CapabilityAxis = "filesystem" | "network" | "secrets";

const SANDBOX_AXES: CapabilityAxis[] = ["filesystem", "network", "secrets"];

/**
 * Union all sandbox-axis capabilities from a list of contributors (e.g.
 * tools). For sandbox axes we merge & dedupe; the `subagent` field on
 * tool capabilities is intentionally not unioned here — it lives on
 * tools as a per-tool broker opt-in, not as an agent-wide ceiling.
 */
export function unionCapabilities(
  parts: Array<ToolCapabilities | SandboxCeiling | undefined>,
): SandboxCeiling {
  const out: SandboxCeiling = {};
  for (const p of parts) {
    if (!p) continue;
    for (const axis of SANDBOX_AXES) {
      const v = (p as SandboxCeiling)[axis];
      if (v === undefined) continue;
      const cur = out[axis];
      const merged = new Set<string>(cur ?? []);
      for (const x of v) merged.add(x);
      out[axis] = Array.from(merged);
    }
  }
  return out;
}

/**
 * Assert that `required` ⊆ `ceiling` for the three sandbox axes.
 *
 * Rules per axis:
 *  - **Absent ceiling axis** (`ceiling.<axis> === undefined`): unconstrained;
 *    skip the check.
 *  - filesystem: each required path must be inside *some* ceiling path
 *    (path-prefix containment).
 *  - network: each required host must match a ceiling entry, where ceiling
 *    entries may be wildcards like `*.example.com`.
 *  - secrets: literal set membership.
 */
export function assertSubset(
  required: SandboxCeiling,
  ceiling: SandboxCeiling,
): void {
  const violations: Record<string, string[]> = {};

  // filesystem
  if (
    required.filesystem &&
    required.filesystem.length > 0 &&
    ceiling.filesystem !== undefined
  ) {
    const c = ceiling.filesystem;
    const bad = required.filesystem.filter(
      (req) => !pathContainedInAny(req, c),
    );
    if (bad.length > 0) violations.filesystem = bad;
  }

  // network
  if (
    required.network &&
    required.network.length > 0 &&
    ceiling.network !== undefined
  ) {
    const c = ceiling.network;
    const bad = required.network.filter((req) => !hostMatchesAny(req, c));
    if (bad.length > 0) violations.network = bad;
  }

  // secrets
  if (
    required.secrets &&
    required.secrets.length > 0 &&
    ceiling.secrets !== undefined
  ) {
    const c = new Set(ceiling.secrets);
    const bad = required.secrets.filter((s) => !c.has(s));
    if (bad.length > 0) violations.secrets = bad;
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
