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
import type { JSONSchema } from "../types/schema.js";
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

// ─── Argument-binding grants (MCP-style provider tools) ───────────────
//
// The historical capability model is "kinds the tool may exercise"
// (paths, subprocess, network, …): one kind per capability concern,
// orthogonal to the tool's input schema. Built-in tools self-police
// on those kinds at execute time.
//
// Provider-contributed tools (notably MCP-backed tools) have a
// different shape: the tool's MCP "args" already ARE structured
// kinds the user wants to constrain. Re-using `[capabilities]` for
// argument binding lets one mechanism do two jobs:
//
//   1. Authorise which model-visible inputs are allowed.
//   2. Pre-bind a fixed value the model never sees.
//
// This block adds the helper that turns a per-arg grant into a
// (narrowed inputSchema, bound merge values, model-visible arg
// names) triple. Per-argument grant semantics:
//
//   | grant value          | schema effect                       | execute effect              |
//   |----------------------|-------------------------------------|-----------------------------|
//   | "<literal>" / number | drop arg from properties + required | merge bound value into call |
//   | true / false (bool)  | drop arg from properties + required | merge bound value into call |
//   | ["a", "b"]           | narrow property to `enum`           | passed through from model   |
//   | "*"                  | unchanged                           | passed through from model   |
//   | (arg absent in grant)| drop arg from properties + required | (model can't supply it)     |
//
// A per-arg map is a strict whitelist: any property the MCP server
// advertises that doesn't appear as a key in the grant is removed
// from the model-visible schema. This makes
// `[capabilities].tool = { a = "*", b = "*" }` mean exactly "the
// model sees a two-arg tool", regardless of what else the server
// offers. Use whole-tool `"*"` to opt out of that and keep the
// full schema.
//
// `"*"` on the whole tool means "full schema, no binding". `{}`
// means "no model-visible args"; boot fails via `assertRequires`
// when the tool has required MCP args that aren't named here
// (literal-bound, enum-narrowed, or kept open with `"*"`).
//
// The default-value form (`{ default = "..." }`) hinted at in the
// implementation prompt is a v2 stretch and intentionally NOT
// implemented here.

/** Result of narrowing a JSON Schema by a capability-set grant. */
export interface AppliedArgGrant {
  /** Narrowed schema the model sees. */
  schema: JSONSchema;
  /** Fixed arg values the provider merges at execute time. */
  bound: Record<string, unknown>;
  /** Property names the model may still provide (after narrowing). */
  modelArgs: Set<string>;
}

/**
 * Narrow a JSON Schema by an argument-binding capability grant.
 * Pure (no error throws); the grant has been pre-validated by
 * `assertRequires` / `assertKnownKinds` upstream.
 *
 *   - `undefined` grant: no narrowing, no binding.
 *   - `"*"` grant:      no narrowing, no binding.
 *   - per-arg map:      see semantics table above.
 */
export function applyArgGrant(
  schema: JSONSchema,
  grant: CapabilitySet | undefined,
): AppliedArgGrant {
  const original = (schema ?? {}) as Record<string, unknown>;
  const properties = isObject(original.properties)
    ? (original.properties as Record<string, unknown>)
    : {};
  const required = Array.isArray(original.required)
    ? (original.required as unknown[]).filter(
        (x): x is string => typeof x === "string",
      )
    : [];
  const allProperties = new Set(Object.keys(properties));

  // Whole-tool grants leave the schema alone.
  if (grant === undefined || grant === "*") {
    return {
      schema,
      bound: {},
      modelArgs: allProperties,
    };
  }
  // Empty grant: nothing pre-bound, nothing narrowed. boot.guards
  // (assertRequires) will reject this when the tool has required
  // args; we just thread the shape through.
  if (typeof grant !== "object" || Array.isArray(grant)) {
    return { schema, bound: {}, modelArgs: allProperties };
  }

  const bound: Record<string, unknown> = {};
  const narrowedProperties: Record<string, unknown> = { ...properties };
  const modelArgs = new Set(allProperties);
  const dropped = new Set<string>();

  // Whitelist pass: anything the MCP server advertises but the grant
  // doesn't name gets dropped from both `properties` and `required`.
  // The model never sees it, and `assertRequires` catches the case
  // where dropping a *required* MCP arg leaves a tool the model can't
  // legally call (the boot guard reads `Tool.requires`, which mirrors
  // the MCP-required list — see `buildLoomTool`).
  for (const prop of allProperties) {
    if (!Object.hasOwn(grant, prop)) {
      delete narrowedProperties[prop];
      modelArgs.delete(prop);
      dropped.add(prop);
    }
  }

  for (const [arg, value] of Object.entries(grant)) {
    if (value === undefined) continue;
    // `"*"` per-arg: leave the property untouched.
    if (value === "*") continue;
    if (isLiteralBindable(value)) {
      // Drop from the visible schema; bind for execute().
      delete narrowedProperties[arg];
      modelArgs.delete(arg);
      dropped.add(arg);
      bound[arg] = value;
      continue;
    }
    if (Array.isArray(value)) {
      // Constrain to an enum. Preserve the original property's
      // metadata (type, description) so the model sees the same
      // shape minus the freedom.
      const orig = isObject(properties[arg])
        ? (properties[arg] as Record<string, unknown>)
        : {};
      narrowedProperties[arg] = { ...orig, enum: [...value] };
      continue;
    }
    // Other grant shapes (objects like `{ default = ... }`) reserved
    // for future use; leave the property untouched.
  }

  // Drop bound args from `required` too — they're satisfied via the
  // merge at execute time, not by the model. (Unlisted args were
  // already added to `dropped` above.)
  const narrowedRequired = required.filter((r) => !dropped.has(r));

  // Rebuild the schema object. Preserve the top-level keys we don't
  // own (description, $schema, additionalProperties, etc.).
  const narrowedSchema: Record<string, unknown> = {
    ...original,
    properties: narrowedProperties,
  };
  if (required.length > 0) {
    if (narrowedRequired.length === 0) {
      delete narrowedSchema.required;
    } else {
      narrowedSchema.required = narrowedRequired;
    }
  }
  return {
    schema: narrowedSchema as JSONSchema,
    bound,
    modelArgs,
  };
}

function isLiteralBindable(v: unknown): v is string | number | boolean {
  if (v === "*") return false;
  return (
    typeof v === "string" || typeof v === "number" || typeof v === "boolean"
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
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
