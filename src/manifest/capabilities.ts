import { CapabilityError, SecretError } from "../errors.js";
import type { Tool } from "../types/interfaces.js";
import type { JSONSchema } from "../types/schema.js";
import type {
  Capabilities,
  CapabilityGrant,
  CapabilitySet,
  CapabilityValue,
  SecretAllowlist,
} from "../types/manifest.js";

export function grantRows(set: CapabilitySet): "*" | CapabilityGrant[] {
  if (set === "*") return "*";
  return Array.isArray(set) ? set : [set];
}

export function grantFor(
  capabilities: Capabilities | undefined,
  toolName: string,
): CapabilitySet | undefined {
  return capabilities?.[toolName];
}

export function isStarSet(grant: CapabilitySet | undefined): boolean {
  return grant === "*";
}

export function kindGranted(
  grant: CapabilitySet | undefined,
  kind: string,
): boolean {
  if (grant === undefined) return false;
  if (grant === "*") return true;
  const rows = grantRows(grant) as CapabilityGrant[];
  return rows.some((row) => Object.prototype.hasOwnProperty.call(row, kind));
}

export function valueFor(
  grant: CapabilitySet | undefined,
  kind: string,
): CapabilityValue | undefined {
  if (grant === undefined) return undefined;
  if (grant === "*") return "*";
  if (Array.isArray(grant)) {
    for (const row of grant) {
      if (Object.prototype.hasOwnProperty.call(row, kind)) return row[kind];
    }
    return undefined;
  }
  return grant[kind];
}

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
    if (typeof grant !== "object" || grant === null) continue;
    const tool = tools.get(name);
    if (!tool) continue;
    const known = new Set([...(tool.requires ?? []), ...(tool.optional ?? [])]);
    const rows = grantRows(grant) as CapabilityGrant[];
    const unknownKinds = [
      ...new Set(
        rows.flatMap((row) => Object.keys(row).filter((k) => !known.has(k))),
      ),
    ];
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

export interface AppliedArgGrant {
  schema: JSONSchema;
  bound: Record<string, unknown>;
  modelArgs: Set<string>;
}

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

  if (grant === undefined || grant === "*") {
    return {
      schema,
      bound: {},
      modelArgs: allProperties,
    };
  }
  if (typeof grant !== "object" || Array.isArray(grant)) {
    return { schema, bound: {}, modelArgs: allProperties };
  }

  const bound: Record<string, unknown> = {};
  const narrowedProperties: Record<string, unknown> = { ...properties };
  const modelArgs = new Set(allProperties);
  const dropped = new Set<string>();

  for (const prop of allProperties) {
    if (!Object.hasOwn(grant, prop)) {
      delete narrowedProperties[prop];
      modelArgs.delete(prop);
      dropped.add(prop);
    }
  }

  for (const [arg, value] of Object.entries(grant)) {
    if (value === undefined) continue;
    if (value === "*") continue;
    if (isLiteralBindable(value)) {
      delete narrowedProperties[arg];
      modelArgs.delete(arg);
      dropped.add(arg);
      bound[arg] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const orig = isObject(properties[arg])
        ? (properties[arg] as Record<string, unknown>)
        : {};
      narrowedProperties[arg] = { ...orig, enum: [...value] };
      continue;
    }
  }

  const narrowedRequired = required.filter((r) => !dropped.has(r));

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

// Strict containment: a kind absent from the superset is NOT granted, and
// every subset row must fit within a single superset row — rows never combine.
export function defaultContains(superset: unknown, subset: unknown): boolean {
  if (subset === undefined) return true;
  if (superset === "*") return true;
  if (subset === "*") return false;
  if (superset === undefined) return isEmptyRequest(subset);
  if (isRowable(superset) && isRowable(subset)) {
    const supRows = toRows(superset);
    const subRows = toRows(subset);
    return subRows.every((subRow) =>
      supRows.some((supRow) => rowContains(supRow, subRow)),
    );
  }
  return valueContains(superset, subset);
}

function isRowable(v: unknown): boolean {
  if (isObject(v)) return true;
  return Array.isArray(v) && v.every((x) => isObject(x));
}

function toRows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? (v as Record<string, unknown>[])
    : [v as Record<string, unknown>];
}

function rowContains(
  sup: Record<string, unknown>,
  sub: Record<string, unknown>,
): boolean {
  for (const k of Object.keys(sub)) {
    if (sub[k] === undefined) continue;
    if (!(k in sup)) return false;
    if (!valueContains(sup[k], sub[k])) return false;
  }
  return true;
}

function valueContains(superset: unknown, subset: unknown): boolean {
  if (subset === undefined) return true;
  if (superset === "*") return true;
  if (subset === "*") return false;
  if (superset === undefined) return false;
  if (Array.isArray(superset) && Array.isArray(subset)) {
    const sup = new Set(superset.map((x) => JSON.stringify(x)));
    return subset.every((x) => sup.has(JSON.stringify(x)));
  }
  if (isObject(superset) && isObject(subset)) {
    return rowContains(superset, subset);
  }
  return JSON.stringify(superset) === JSON.stringify(subset);
}

function isEmptyRequest(subset: unknown): boolean {
  if (subset === undefined) return true;
  if (isObject(subset)) return Object.keys(subset).length === 0;
  if (Array.isArray(subset)) {
    return subset.every((row) => isEmptyRequest(row));
  }
  return false;
}

// "*" absorbs; otherwise the deduplicated union of row sets — lossless,
// never the kind-wise bounding box.
export function defaultMerge(
  a: CapabilitySet,
  b: CapabilitySet,
): CapabilitySet {
  if (a === "*" || b === "*") return "*";
  const rows = [...(grantRows(a) as CapabilityGrant[])];
  const seen = new Set(rows.map((r) => JSON.stringify(r)));
  for (const row of grantRows(b) as CapabilityGrant[]) {
    const key = JSON.stringify(row);
    if (!seen.has(key)) {
      seen.add(key);
      rows.push(row);
    }
  }
  if (rows.length === 1) return rows[0] as CapabilityGrant;
  return rows;
}

export function containsWithTool(
  tool: Tool | undefined,
  superset: CapabilitySet | undefined,
  subset: CapabilitySet,
): boolean {
  if (tool?.containsGrant) return tool.containsGrant(superset, subset);
  return defaultContains(superset, subset);
}

export function mergeWithTool(
  tool: Tool | undefined,
  a: CapabilitySet,
  b: CapabilitySet,
): CapabilitySet {
  const merged = tool?.mergeGrants
    ? tool.mergeGrants(a, b)
    : defaultMerge(a, b);
  if (
    !containsWithTool(tool, merged, a) ||
    !containsWithTool(tool, merged, b)
  ) {
    throw new CapabilityError(
      `Capability merge law violated${tool ? ` by tool '${tool.name}'` : ""}: ` +
        `merge(a, b) must contain both a and b under containsGrant. ` +
        `This is a bug in the tool's capability algebra.`,
      { a, b } as Record<string, unknown>,
      { merged } as Record<string, unknown>,
    );
  }
  return merged;
}
