import { CapabilityError, SecretError } from "../errors.js";
import type { Tool } from "../types/interfaces.js";
import type { JSONSchema } from "../types/schema.js";
import type {
  Capabilities,
  CapabilitySet,
  CapabilityValue,
  SecretAllowlist,
} from "../types/manifest.js";

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
  return Object.prototype.hasOwnProperty.call(grant, kind);
}

export function valueFor(
  grant: CapabilitySet | undefined,
  kind: string,
): CapabilityValue | undefined {
  if (grant === undefined) return undefined;
  if (grant === "*") return "*";
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
    if (typeof grant !== "object" || grant === null || Array.isArray(grant)) {
      continue;
    }
    const tool = tools.get(name);
    if (!tool) continue;
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

export function defaultContains(superset: unknown, subset: unknown): boolean {
  if (subset === undefined) return true;
  if (superset === undefined) return true;
  if (superset === "*") return true;
  if (subset === "*") return false;
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
