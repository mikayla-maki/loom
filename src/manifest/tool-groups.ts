import type { Agent, Session, Tool, Tools } from "../types/interfaces.js";
import type {
  Capabilities,
  CapabilitySet,
  DeclarationVerdict,
  Providers,
  ToolEntry,
  ToolEntryTable,
  ToolGroup,
  ToolGroupVerdict,
} from "../types/manifest.js";
import { containsWithTool, mergeWithTool } from "./capabilities.js";
import { parseProviders, parseToolTable } from "./parser.js";

const RESERVED_PROVIDER_HANDLES = new Set(["builtin", "session"]);

export type { DeclarationVerdict, ToolGroupVerdict };

export interface AppliedToolGroups {
  /**
   * Tool entries to bind: manifest entries plus accepted contributed
   * entries, with matched contributions merged into existing grants.
   */
  tools: Record<string, ToolEntry>;
  /**
   * The effective ceiling: `[capabilities]` unioned with the manifest's
   * inline tool declarations (root declarations are self-authorizing).
   */
  ceiling: Capabilities;
  verdicts: ToolGroupVerdict[];
}

interface InstanceState {
  entry: ToolEntryTable;
  origin: string;
}

export function ceilingEntryFor(
  ceiling: Capabilities,
  instanceName: string,
  underlyingName: string,
): { key: string; grant: CapabilitySet } | undefined {
  if (Object.hasOwn(ceiling, instanceName)) {
    return { key: instanceName, grant: ceiling[instanceName] as CapabilitySet };
  }
  if (Object.hasOwn(ceiling, underlyingName)) {
    return {
      key: underlyingName,
      grant: ceiling[underlyingName] as CapabilitySet,
    };
  }
  return undefined;
}

export function underlyingNameOfEntry(
  instanceName: string,
  entry: ToolEntry,
): string {
  if (typeof entry === "string") return instanceName;
  return entry.tool ?? instanceName;
}

/**
 * Judge one contributed declaration against the effective ceiling (for
 * catalog trimming, pass `agent.capabilities`). A declaration without a
 * `capabilities` request is always granted.
 */
export function containsDeclaration(args: {
  ceiling: Capabilities;
  instance: string;
  underlying: string;
  request: CapabilitySet | undefined;
  tool?: Tool;
}): DeclarationVerdict {
  const { ceiling, instance, underlying, request, tool } = args;
  const entry = ceilingEntryFor(ceiling, instance, underlying);
  if (request === undefined) {
    return {
      instance,
      underlying,
      ok: true,
      ...(entry ? { against: entry.key } : {}),
    };
  }
  if (entry && containsWithTool(tool, entry.grant, request)) {
    return { instance, underlying, ok: true, against: entry.key };
  }
  return {
    instance,
    underlying,
    ok: false,
    ...(entry ? { against: entry.key } : {}),
    reason: entry
      ? `request exceeds [capabilities].${entry.key}`
      : `nothing in the capability ceiling grants '${instance}' (or '${underlying}')`,
    remediation: remediationFor(underlying, request),
  };
}

function remediationFor(key: string, request: CapabilitySet): string {
  return `${key} = ${tomlValue(request)}`;
}

function tomlValue(v: unknown): string {
  if (v === "*") return `"*"`;
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    return `[${v.map((x) => tomlValue(x)).join(", ")}]`;
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return "{ }";
    const inner = entries
      .map(([k, val]) => `${k} = ${tomlValue(val)}`)
      .join(", ");
    return `{ ${inner} }`;
  }
  return JSON.stringify(v);
}

/**
 * Fold contributed tool groups into a manifest's tool entries. Groups are
 * fail-soft: each is accepted atomically or rejected with per-declaration
 * verdicts.
 */
export function applyToolGroups(args: {
  manifestTools: Record<string, ToolEntry>;
  capabilities: Capabilities;
  groups: ToolGroup[];
  toolFor?: (instance: string, underlying: string) => Tool | undefined;
}): AppliedToolGroups {
  const { manifestTools, capabilities, groups, toolFor } = args;

  const instances = new Map<string, InstanceState>();
  const ceiling: Capabilities = { ...capabilities };
  for (const [name, entry] of Object.entries(manifestTools)) {
    const table: ToolEntryTable =
      typeof entry === "string" ? { provider: entry } : { ...entry };
    instances.set(name, { entry: table, origin: `[tools.${name}]` });
    if (table.capabilities === undefined) continue;
    const underlying = underlyingNameOfEntry(name, entry);
    const existing = ceiling[name];
    ceiling[name] =
      existing === undefined
        ? table.capabilities
        : mergeWithTool(
            toolFor?.(name, underlying),
            existing,
            table.capabilities,
          );
  }

  const verdicts: ToolGroupVerdict[] = [];
  for (const group of groups) {
    const declarations: DeclarationVerdict[] = [];
    const staged: Array<{
      name: string;
      table: ToolEntryTable;
      matched: InstanceState | undefined;
    }> = [];
    for (const [name, entry] of Object.entries(group.tools)) {
      const table = substituteGroupProvider(
        typeof entry === "string" ? { provider: entry } : { ...entry },
        group.providers,
      );
      const existing = instances.get(name);

      if (existing === undefined && table.provider === undefined) {
        declarations.push({
          instance: name,
          underlying: table.tool ?? name,
          ok: false,
          reason:
            `matches no existing tool instance and declares no provider; ` +
            `a provider-less entry can only contribute grants to an ` +
            `instance that already exists`,
        });
        continue;
      }
      // Materializing a provider runs code before any verdict-gated tool, so
      // a contributed NEW instance shipping its own implementation requires
      // explicit instance-name acceptance in [capabilities].
      const contributedSource =
        existing === undefined && typeof table.provider === "object";
      if (contributedSource && !Object.hasOwn(ceiling, name)) {
        declarations.push({
          instance: name,
          underlying: table.tool ?? name,
          ok: false,
          reason:
            `ships its own implementation (${JSON.stringify(table.provider)}); ` +
            `running contributed code requires naming the instance in ` +
            `[capabilities]`,
          remediation: `${name} = ${tomlValue(table.capabilities ?? {})}`,
        });
        continue;
      }
      if (existing !== undefined && !entriesMatch(existing.entry, table)) {
        declarations.push({
          instance: name,
          underlying: table.tool ?? name,
          ok: false,
          reason:
            `collides with ${existing.origin}, which resolves to a ` +
            `different implementation. Pick a different instance name.`,
        });
        continue;
      }

      const underlying = existing
        ? underlyingNameOfEntry(name, existing.entry)
        : (table.tool ?? name);
      const verdict = containsDeclaration({
        // Contributed sources are judged against their instance-name entry
        // only; the underlying-name fallback must not widen acceptance.
        ceiling: contributedSource
          ? { [name]: ceiling[name] as CapabilitySet }
          : ceiling,
        instance: name,
        underlying,
        request: table.capabilities,
        ...(toolFor ? { tool: toolFor(name, underlying) } : {}),
      });
      declarations.push(verdict);
      if (verdict.ok) staged.push({ name, table, matched: existing });
    }

    const accepted = declarations.length > 0 && declarations.every((d) => d.ok);
    verdicts.push({ label: group.label, accepted, declarations });
    if (!accepted) continue;

    for (const { name, table, matched } of staged) {
      if (matched) {
        if (table.capabilities !== undefined) {
          const underlying = underlyingNameOfEntry(name, matched.entry);
          const tool = toolFor?.(name, underlying);
          // A bare entry implicitly requests its full ceiling entry;
          // materialize that before merging so contributions extend the
          // instance's grant — they must never narrow it.
          const base =
            matched.entry.capabilities ??
            ceilingEntryFor(ceiling, name, underlying)?.grant;
          matched.entry.capabilities =
            base === undefined
              ? table.capabilities
              : mergeWithTool(tool, base, table.capabilities);
        }
      } else {
        instances.set(name, {
          entry: table,
          origin: group.label,
        });
      }
    }
  }

  const tools: Record<string, ToolEntry> = {};
  for (const [name, state] of instances) {
    tools[name] = state.entry;
  }
  return { tools, ceiling, verdicts };
}

// Same implementation (provider reference + underlying name): grants
// compose, implementations don't.
function entriesMatch(
  existing: ToolEntryTable,
  candidate: ToolEntryTable,
): boolean {
  if (
    candidate.provider !== undefined &&
    !referencesEqual(existing.provider, candidate.provider)
  ) {
    return false;
  }
  if (candidate.tool !== undefined && candidate.tool !== existing.tool) {
    return false;
  }
  return true;
}

function referencesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Groups go through the same parser as the manifest; groups that fail to
// parse are dropped (producers surface their own authoring errors).
export async function collectToolGroups(
  session: Session,
): Promise<ToolGroup[]> {
  if (typeof session.tools !== "function") return [];
  const groups = (await Promise.resolve(session.tools())) ?? [];
  const out: ToolGroup[] = [];
  for (const group of groups) {
    const parsed = parseGroup(group);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseGroup(group: ToolGroup): ToolGroup | undefined {
  if (!group || typeof group !== "object") return undefined;
  if (typeof group.label !== "string" || group.label.length === 0) {
    return undefined;
  }
  try {
    const tools = parseToolTable(group.tools, group.label, {
      requireProvider: false,
    });
    const out: ToolGroup = { label: group.label, tools };
    if (group.providers !== undefined) {
      const providers = parseProviders(group.providers, group.label);
      for (const handle of Object.keys(providers)) {
        if (RESERVED_PROVIDER_HANDLES.has(handle)) return undefined;
      }
      out.providers = providers;
    }
    return out;
  } catch {
    return undefined;
  }
}

function substituteGroupProvider(
  table: ToolEntryTable,
  providers: Providers | undefined,
): ToolEntryTable {
  if (!providers || typeof table.provider !== "string") return table;
  const entry = providers[table.provider];
  if (entry === undefined) return table;
  return { ...table, provider: entry };
}

// Builtin implementations are pure to construct, so a throwaway instance
// supplies the tool-owned algebra for pre-bind declaration checking.
export function probeTool(
  registry: Tools,
  instance: string,
  underlying: string,
  agent: Agent,
): Tool | undefined {
  try {
    const config = instance === underlying ? {} : { tool: underlying };
    const tool = registry.resolveTool?.(instance, config, agent, undefined);
    return tool instanceof Promise ? undefined : (tool ?? undefined);
  } catch {
    return undefined;
  }
}

/** Convenience for catalog trimming: does every declaration qualify? */
export function toolGroupQualifies(
  group: ToolGroup,
  ceiling: Capabilities,
  toolFor?: (instance: string, underlying: string) => Tool | undefined,
): boolean {
  for (const [name, entry] of Object.entries(group.tools)) {
    const table: ToolEntryTable =
      typeof entry === "string" ? { provider: entry } : entry;
    if (table.capabilities === undefined) continue;
    const underlying = underlyingNameOfEntry(name, entry);
    const tool = toolFor?.(name, underlying);
    if (
      !containsDeclaration({
        ceiling,
        instance: name,
        underlying,
        request: table.capabilities,
        ...(tool ? { tool } : {}),
      }).ok
    ) {
      return false;
    }
  }
  return true;
}
