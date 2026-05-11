/**
 * Capability boot-time validation.
 *
 * The manifest's `[capabilities]` table is the single source of truth
 * for what each tool may do. It's keyed by the same names as `[tools]`;
 * each value is `"*"` (whole tool unrestricted) or a per-kind map.
 *
 * Each tool declares the kinds it requires (`Tool.requires`) and the
 * kinds it may use if granted (`Tool.optional`). At boot:
 *
 *   1. `assertRequires` checks every required kind is granted.
 *   2. `assertSecretAllowlist` checks tool secret names fit the
 *      manifest's `[agent].secrets` allowlist (when set).
 *
 * Loom doesn't interpret kind argument shapes (paths, buckets, hosts,
 * channels, …). Tools self-police on every dispatch by reading their
 * stored `capabilities` field.
 */

import { CapabilityError, SecretError } from "../errors.js";
import type { Tool } from "../types/interfaces.js";
import type {
  Capabilities,
  CapabilitySet,
  CapabilityValue,
  SecretAllowlist,
} from "../types/manifest.js";

/**
 * Read the granted set for a tool. Returns the manifest's entry, or
 * `undefined` when the manifest declares no grant for this name.
 *
 * "Whole-tool unrestricted" is signalled by `"*"`; the helpers below
 * (`isStarSet`, `kindGranted`) flatten the cases.
 */
export function grantFor(
  capabilities: Capabilities | undefined,
  toolName: string,
): CapabilitySet | undefined {
  return capabilities?.[toolName];
}

/** Whether a grant authorises every kind. */
export function isStarSet(grant: CapabilitySet | undefined): boolean {
  return grant === "*";
}

/**
 * Whether `kind` is granted by `grant`. `"*"` grants every kind;
 * otherwise the kind must be a key of the per-kind map (any value
 * other than `undefined`).
 */
export function kindGranted(
  grant: CapabilitySet | undefined,
  kind: string,
): boolean {
  if (grant === undefined) return false;
  if (grant === "*") return true;
  return Object.prototype.hasOwnProperty.call(grant, kind);
}

/**
 * Lookup the value granted to a single kind. Returns `"*"` when the
 * whole grant is `"*"` (every kind unrestricted), the literal kind
 * value when the grant is a per-kind map, or `undefined` when the
 * kind isn't granted.
 */
export function valueFor(
  grant: CapabilitySet | undefined,
  kind: string,
): CapabilityValue | undefined {
  if (grant === undefined) return undefined;
  if (grant === "*") return "*";
  return grant[kind];
}

/**
 * Boot guard: every kind in a structured grant must be one the tool
 * declares it understands (in `requires` or `optional`). Catches typos
 * and the silent footgun of granting kinds the tool doesn't read —
 * which would otherwise leave the user thinking they'd constrained
 * the tool when they hadn't.
 *
 * Whole-tool `"*"` grants are exempt: that's an explicit opt-out of
 * the strictness. Empty `{}` grants are fine (no kinds to check).
 */
export function assertKnownKinds(
  tools: Map<string, Tool>,
  capabilities: Capabilities | undefined,
): void {
  if (capabilities === undefined) return;
  const violations: Array<{
    tool: string;
    unknown: string[];
    declared: string[];
  }> = [];
  for (const [name, grant] of Object.entries(capabilities)) {
    if (grant === "*") continue;
    if (typeof grant !== "object" || grant === null || Array.isArray(grant)) {
      continue;
    }
    const tool = tools.get(name);
    if (!tool) continue; // unresolved tools surface elsewhere
    const known = new Set([...(tool.requires ?? []), ...(tool.optional ?? [])]);
    const unknownKinds = Object.keys(grant).filter((k) => !known.has(k));
    if (unknownKinds.length > 0) {
      violations.push({
        tool: name,
        unknown: unknownKinds,
        declared: [...known].sort(),
      });
    }
  }
  if (violations.length > 0) {
    const summary = violations
      .map((v) => {
        const declared =
          v.declared.length === 0
            ? "(none)"
            : v.declared.map((k) => `'${k}'`).join(", ");
        return `  - ${v.tool}: granted ${v.unknown
          .map((k) => `'${k}'`)
          .join(", ")} but tool only knows ${declared}`;
      })
      .join("\n");
    throw new CapabilityError(
      `Capability grants reference kinds the tool doesn't declare. Either remove\n` +
        `them, fix the typo, or grant "*" to opt out of kind-checking:\n${summary}`,
      Object.fromEntries(violations.map((v) => [v.tool, v.unknown])),
      capabilities,
    );
  }
}

/**
 * Boot guard: every required kind a tool declares must be granted.
 * Aggregates violations across the tool table into a single error.
 *
 * Optional kinds are NOT checked here — they're informational, used
 * for audit and (where applicable) sandbox profile derivation. A tool
 * with an optional kind that wasn't granted just runs without it.
 */
export function assertRequires(
  tools: Map<string, Tool>,
  capabilities: Capabilities | undefined,
): void {
  const violations: Array<{ tool: string; missing: string[] }> = [];
  for (const [name, tool] of tools) {
    const required = tool.requires ?? [];
    if (required.length === 0) continue;
    const grant = grantFor(capabilities, name);
    const missing: string[] = [];
    for (const kind of required) {
      if (!kindGranted(grant, kind)) missing.push(kind);
    }
    if (missing.length > 0) {
      violations.push({ tool: name, missing });
    }
  }
  if (violations.length > 0) {
    const summary = violations
      .map(
        (v) =>
          `  - ${v.tool}: missing required ${v.missing.map((k) => `'${k}'`).join(", ")}`,
      )
      .join("\n");
    throw new CapabilityError(
      `Tool capability requirements unmet (declare grants in [capabilities]):\n${summary}`,
      Object.fromEntries(violations.map((v) => [v.tool, v.missing])),
      capabilities ?? {},
    );
  }
}

/**
 * Boot guard: every secret name a tool wants must fit inside the
 * manifest's `[agent].secrets` allowlist. Absent allowlist or `"*"`
 * means no ceiling; an array means the closure of all tool secret
 * names must be ⊆ that array.
 */
export function assertSecretAllowlist(
  tools: Map<string, Tool>,
  allowlist: SecretAllowlist | undefined,
): void {
  if (allowlist === undefined || allowlist === "*") return;
  const allowed = new Set(allowlist);
  const violations: Array<{ tool: string; secrets: string[] }> = [];
  for (const [name, tool] of tools) {
    const wanted = [
      ...(tool.secrets?.required ?? []),
      ...(tool.secrets?.optional ?? []),
    ];
    const offending = wanted.filter((s) => !allowed.has(s));
    if (offending.length > 0) {
      violations.push({ tool: name, secrets: offending });
    }
  }
  if (violations.length > 0) {
    const summary = violations
      .map(
        (v) =>
          `  - ${v.tool}: secrets ${v.secrets.map((s) => `'${s}'`).join(", ")} not in [agent].secrets allowlist`,
      )
      .join("\n");
    throw new SecretError(
      `Tool secret needs exceed the [agent].secrets allowlist (${allowlist.length === 0 ? "empty" : `${allowlist.length} allowed`}):\n${summary}`,
    );
  }
}

/**
 * Structural deep-subset check, extended for the `"*"` wildcard.
 * Used by audit-tree comparisons (parent grant vs child grant), not
 * by the boot guard. The boot guard is `assertRequires`, which is
 * presence-only.
 *
 *   - `"*"` superset contains anything.
 *   - `"*"` subset is contained only by `"*"`.
 *   - Arrays: subset items ⊆ superset items (string equality).
 *   - Objects: every subset key must be in superset; recurse.
 *   - Primitives: deep-equal.
 *   - `undefined` superset: unconstrained (contains anything).
 *   - `undefined` subset: trivially contained.
 */
export function defaultContains(superset: unknown, subset: unknown): boolean {
  if (subset === undefined) return true;
  if (superset === undefined) return true;
  if (superset === "*") return true;
  if (subset === "*") return false; // only "*" contains "*", handled above
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
