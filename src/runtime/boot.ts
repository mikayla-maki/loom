/**
 * Shared boot helpers used by both `runAgent` (the runtime) and
 * `auditAgent` (static introspection).
 *
 * The two callers walk the same pipeline — resolve manifest → load
 * providers → materialise Tools → instantiate harness/session — but
 * differ on *policy*: the runtime is strict (any failure throws and
 * aborts boot), audit is lenient (failures are recorded so the rest
 * of the tree is still informative).
 *
 * This module factors the structural code out so both callers share
 * the same lookup rules, error messages, and convention for
 * package-name-as-primary-factory resolution.
 *
 * Things deliberately NOT here:
 *   - Tools `init()` and runtime services. That's a runtime-only
 *     phase (audit doesn't init Tools — init can have side effects
 *     like opening MCP connections).
 *   - Secret resolution. The caller passes already-filtered secrets;
 *     `secretsFor` lives in `run-agent.ts` next to the secret store
 *     plumbing.
 *   - Tool binding. The two callers diverge enough on tool binding
 *     (runtime throws on misses; audit records them) that the
 *     shared helper would mostly be `if (audit) {...} else {...}`.
 */

import * as path from "node:path";

import { ResolutionError } from "../errors.js";
import { findToolsFactory } from "../builtins/index.js";
import {
  loadProviderFromSource,
  type ContributionRegistration,
  type LoadedProvider,
  type LoadOptions as ProviderLoadOptions,
} from "../providers/loader.js";
import type {
  Agent,
  FactoryContext,
  SecretNeeds,
  Tools,
} from "../types/interfaces.js";
import type { SourceSpec } from "../types/manifest.js";
import {
  sourceSpecKey,
  type HarnessBinding,
  type ProviderInstance,
  type ResolvedManifest,
  type SessionBinding,
} from "../manifest/resolver.js";

// ─── Tools-contribution indexing ─────────────────────────────────────────

/**
 * Provider-contributed Tools registrations, keyed by
 * `${sourceKey}::${contributionName}`.
 */
export type ToolsIndex = Map<string, ContributionRegistration<Tools>>;

/** Stable composite key for the `ToolsIndex`. */
export function toolsContributionKey(
  sourceKey: string,
  contributionName: string,
): string {
  return `${sourceKey}::${contributionName}`;
}

/**
 * The default factory name a provider's primary contributions are
 * registered under. v5 convention: providers register their primary
 * Tools / harness / session contribution under their package name.
 */
export function defaultProviderName(spec: SourceSpec): string {
  if ("npm" in spec) return spec.npm;
  if ("path" in spec) return path.basename(spec.path);
  return "unknown";
}

// ─── Factory lookup with the package-name fallback ───────────────────────

/**
 * Look up a harness/session factory by name. When the binding came
 * from a `[providers]` handle (i.e. `source` is set), the registered
 * factory name may not match the handle — by v5 convention, providers
 * register their primary contribution under the package name. Fall
 * back to that when the handle lookup misses.
 *
 * Used by both runtime and audit; rethrows the original error if the
 * fallback also fails.
 */
export function lookupFactoryByBinding<T extends { name: string }>(
  factoryName: string,
  source: SourceSpec | undefined,
  lookup: (name: string) => T,
): T {
  try {
    return lookup(factoryName);
  } catch (originalError) {
    if (source) {
      const fallback = defaultProviderName(source);
      if (fallback !== factoryName) {
        try {
          return lookup(fallback);
        } catch {
          /* fall through; throw the augmented error below */
        }
      }
      // Wrap the lookup failure with manifest ↔ source context so
      // the user sees WHY both names were tried, not just "unknown
      // factory '<handle>'". The original error's list of registered
      // factories is preserved at the end.
      const sourceKey = sourceSpecKey(source);
      const orig =
        originalError instanceof Error
          ? originalError.message
          : String(originalError);
      throw new ResolutionError(
        `Couldn't resolve factory for source '${sourceKey}'. Tried two ` +
          `names:\n` +
          `  - '${factoryName}' (from the manifest reference — a [providers] ` +
          `handle or a direct provider= value)\n` +
          `  - '${fallback}' (the package's primary name, by v5 convention)\n` +
          `Neither is in the runtime registry. Either the package's ` +
          `register() needs to use one of those names (the convention is ` +
          `the primary name '${fallback}'), or the manifest needs to ` +
          `reference a name the package actually registered.\n\n` +
          orig,
      );
    }
    throw originalError;
  }
}

// ─── Provider loading ────────────────────────────────────────────────────

export interface LoadManifestProvidersResult {
  /**
   * Tools contributions from every successfully-loaded provider,
   * indexed by (source key, contribution name). Each contribution is
   * also indexed under the package's primary name (per the v5
   * convention) when the contribution's declared name differs.
   */
  toolsIndex: ToolsIndex;
  /** Per-source `LoadedProvider` for providers that loaded successfully. */
  loaded: Map<string, LoadedProvider>;
  /**
   * Per-source load failures. Empty on success. The runtime treats
   * any non-empty map as fatal; audit records each error and keeps
   * going.
   */
  loadErrors: Map<string, Error>;
}

/**
 * Load every distinct provider source the resolved manifest references.
 * Errors are collected per source key — the caller decides whether to
 * abort.
 */
export async function loadManifestProviders(
  resolved: ResolvedManifest,
  factoryCtx: FactoryContext,
  options: { loadOptions?: ProviderLoadOptions } = {},
): Promise<LoadManifestProvidersResult> {
  const toolsIndex: ToolsIndex = new Map();
  const loaded = new Map<string, LoadedProvider>();
  const loadErrors = new Map<string, Error>();

  for (const [key, resolvedSrc] of resolved.sources) {
    const loadCtx = {
      agentManifestDir: factoryCtx.manifestDir,
      agentName: factoryCtx.agentName,
      loomVersion: factoryCtx.loomVersion,
      providerName: resolvedSrc.handle ?? defaultProviderName(resolvedSrc.spec),
    };
    let provider: LoadedProvider;
    try {
      provider = await loadProviderFromSource(
        resolvedSrc.spec,
        loadCtx,
        options.loadOptions ?? {},
      );
    } catch (e) {
      loadErrors.set(key, e as Error);
      continue;
    }
    loaded.set(key, provider);
    for (const t of provider.toolsContributions) {
      // Index under the contribution's declared name.
      toolsIndex.set(toolsContributionKey(key, t.name), t);
      // Also index under the package's "primary" name so that bare
      // `@org/pkg` references (whose factoryName defaults to the
      // package name in the resolver) resolve without the provider
      // having to use the package name verbatim.
      if (t.name !== provider.info.name) {
        const primaryKey = toolsContributionKey(key, provider.info.name);
        if (!toolsIndex.has(primaryKey)) {
          toolsIndex.set(primaryKey, t);
        }
      }
    }
  }

  return { toolsIndex, loaded, loadErrors };
}

// ─── Per-instance Tools materialisation ──────────────────────────────────

/**
 * Construct a `Tools` instance for a provider-backed `ProviderInstance`
 * by looking up its contribution in the index and calling `create()`
 * with the instance's config, factory context, and resolved secrets.
 *
 * Does NOT call `Tools.init()` — that's a runtime-only phase.
 *
 * The native provider is special-cased by callers (it's stateless
 * and doesn't need provider lookup); this helper handles only
 * `kind === "provider"` instances.
 */
export async function materialiseTools(
  instance: ProviderInstance,
  toolsIndex: ToolsIndex,
  ctx: FactoryContext,
  secrets: Record<string, string>,
  parent: Agent | undefined,
): Promise<{
  tools: Tools;
  contribution: ContributionRegistration<Tools>;
}> {
  if (instance.kind !== "provider") {
    throw new ResolutionError(
      `materialiseTools: instance ${instance.id} is not provider-backed`,
    );
  }
  // Two materialisation paths:
  //   1. Source-backed — contribution from the on-disk provider loader
  //      (ToolsIndex), keyed by source.
  //   2. Factory-backed — built-in / SDK-registered Tools meta-factory
  //      from `builtins/index.ts`, looked up by name.
  let contribution: ContributionRegistration<Tools>;
  if (instance.source) {
    contribution = pickToolsContribution(toolsIndex, instance);
  } else if (instance.factoryName) {
    const fromBuiltin = findToolsFactory(instance.factoryName);
    if (!fromBuiltin) {
      throw new ResolutionError(
        `materialiseTools: built-in Tools factory '${instance.factoryName}' is ` +
          `not registered. ${describeOrigin(instance)}. Built-in factories live ` +
          `in src/builtins/provider/; SDK consumers can also call ` +
          `registerToolsFactory(...) before booting.`,
      );
    }
    contribution = fromBuiltin;
  } else {
    throw new ResolutionError(
      `materialiseTools: instance ${instance.id} is missing both source and factoryName`,
    );
  }
  const tools = await Promise.resolve(
    contribution.create(instance.config, ctx, secrets, parent),
  );
  return { tools, contribution };
}

/**
 * Pick the Tools contribution for an instance. Tries the package's
 * default name first (v5 convention) and falls back to any
 * contribution from the same source.
 */
function pickToolsContribution(
  index: ToolsIndex,
  instance: ProviderInstance,
): ContributionRegistration<Tools> {
  const srcKey = sourceSpecKey(instance.source!);
  const primary = index.get(
    toolsContributionKey(srcKey, defaultProviderName(instance.source!)),
  );
  if (primary) return primary;
  // Fallback: any contribution from this source. Useful when a
  // provider registered only one contribution under a non-default name.
  for (const [key, contribution] of index) {
    if (key.startsWith(`${srcKey}::`)) return contribution;
  }
  throw new ResolutionError(
    `No Tools contribution found for ${describeOrigin(instance)} ` +
      `(source ${srcKey}). Check that the provider's register() called ` +
      `api.registerTools().`,
  );
}

function describeOrigin(instance: ProviderInstance): string {
  switch (instance.origin.kind) {
    case "native":
      return "the native provider";
    case "handle-anonymous":
      return `(via [providers].${instance.origin.providerHandle})`;
    case "handle-factory":
      return `(via [providers].${instance.origin.providerHandle} → factory '${instance.origin.factoryName}')`;
    case "inline-anonymous":
      return instance.origin.toolName
        ? `(inline at [tools.${instance.origin.toolName}])`
        : "(inline)";
  }
}

// ─── Harness / session instantiation ─────────────────────────────────────

/**
 * Common shape for HarnessFactory / SessionFactory. Both accept the
 * same arg list; only the return type differs.
 */
export interface FactoryLike<T> {
  readonly name: string;
  readonly secrets?: SecretNeeds;
  readonly requiresParent?: boolean;
  create(
    config: Record<string, unknown>,
    ctx: FactoryContext,
    secrets: Record<string, string>,
    parent?: Agent,
  ): Promise<T> | T;
}

/**
 * Instantiate a harness or session from its resolved binding.
 *
 *   1. Look up the factory (with the package-name fallback).
 *   2. Enforce `requiresParent`.
 *   3. Call `factory.create(config, ctx, secrets, parent)`.
 *
 * Secrets are filtered by the caller (the runtime resolves them via
 * the SecretsStore; audit passes `{}` and relies on lenient
 * factories). Throws `ResolutionError` on factory miss or
 * `requiresParent` violation.
 */
export async function instantiateFromBinding<T>(
  binding: HarnessBinding | SessionBinding,
  lookup: (name: string) => FactoryLike<T>,
  ctx: FactoryContext,
  secrets: Record<string, string>,
  parent: Agent | undefined,
  kindLabel: "harness" | "session",
): Promise<{ instance: T; factory: FactoryLike<T> }> {
  const factory = lookupFactoryByBinding(
    binding.factoryName,
    binding.source,
    lookup,
  );
  if (factory.requiresParent && !parent) {
    throw new ResolutionError(
      `${capitalise(kindLabel)} '${factory.name}' requires a parent agent ` +
        `and cannot be used at the top level. Construct it inside a ` +
        `tool/session that spawns this manifest as a sub-agent.`,
    );
  }
  const instance = await Promise.resolve(
    factory.create(binding.config, ctx, secrets, parent),
  );
  return { instance, factory };
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
