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

export type ToolsIndex = Map<string, ContributionRegistration<Tools>>;

export function toolsContributionKey(
  sourceKey: string,
  contributionName: string,
): string {
  return `${sourceKey}::${contributionName}`;
}

export function defaultProviderName(spec: SourceSpec): string {
  if ("npm" in spec) return spec.npm;
  if ("path" in spec) return path.basename(spec.path);
  return "unknown";
}

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
          // fall through to the augmented error below
        }
      }
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

export interface LoadManifestProvidersResult {
  toolsIndex: ToolsIndex;
  loaded: Map<string, LoadedProvider>;
  loadErrors: Map<string, Error>;
}

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
      toolsIndex.set(toolsContributionKey(key, t.name), t);
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

function pickToolsContribution(
  index: ToolsIndex,
  instance: ProviderInstance,
): ContributionRegistration<Tools> {
  const srcKey = sourceSpecKey(instance.source!);
  const primary = index.get(
    toolsContributionKey(srcKey, defaultProviderName(instance.source!)),
  );
  if (primary) return primary;
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
