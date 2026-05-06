/**
 * runAgent — the top-level SDK entry point.
 *
 * Resolves a manifest, loads extensions / providers, fetches secrets,
 * validates capabilities, instantiates session + harness, and returns a
 * RunningAgent SDK handle. Does NOT run a turn — the client triggers
 * turns via prompt().
 */

import * as path from "node:path";

import {
  getHarnessFactory,
  getProviderFactory,
  getSessionFactory,
} from "../extensions/index.js";
import { loadExtensionPackage, type LoadOptions } from "../extensions/loader.js";
import {
  resolveAgent,
  type ResolveOptions,
  type ResolvedAgent,
  type ResolvedSubagent,
} from "../manifest/resolver.js";
import { parseAgentManifest } from "../manifest/parser.js";
import { LocalRegistry } from "../registry/registry.js";
import { AgentState } from "../runtime/agent-state.js";
import { findBuiltinsDir } from "../runtime/builtins-dir.js";
import { AddSkillTool, SearchSkillsTool, type SkillDiscoveryDeps } from "../runtime/skill-discovery.js";
import { ProcessTool, ToolTable } from "../runtime/tool-table.js";
import { SpawnSubagentTool, SubagentRegistry } from "../runtime/subagent.js";
import { UpdateSink } from "../runtime/update-sink.js";
import {
  ChainedSecretsStore,
  EnvSecretsStore,
  FileSecretsStore,
  resolveSecrets,
  StaticSecretsStore,
  type SecretsStore,
} from "../runtime/secrets.js";
import type {
  ExtensionContext,
  HarnessFactory,
  Provider,
  Session,
  SessionFactory,
  Tool,
} from "../types/interfaces.js";
import type { PermissionHandler } from "../types/permissions.js";
import type { SkillManifest } from "../types/manifest.js";

import { RunningAgentImpl, type RunningAgent } from "./running-agent.js";

export const GLASS_VERSION = "0.1.0";

const PRIVILEGED_BUILTINS = new Set(["spawn_subagent", "search_skills", "add_skill"]);

export interface RunAgentOptions {
  resolve?: ResolveOptions;
  secrets?: SecretsStore;
  /** If a secret is missing, omit it rather than throwing. */
  allowMissingSecrets?: boolean;
  /** Override the agent's session factory (e.g. tests want memory). */
  sessionOverride?: SessionFactory;
  /** Override the agent's harness factory (e.g. tests want test). */
  harnessOverride?: { factory: HarnessFactory; config?: Record<string, unknown> };
  harnessConfigOverride?: Record<string, unknown>;
  sessionConfigOverride?: Record<string, unknown>;
  /** Programmatic providers — appended to manifest [providers]. */
  providers?: Provider[];
  /** Capability-expansion gate. Defaults to deny-all if unset. */
  permissionHandler?: PermissionHandler;
  /** Extension-package search-path overrides (used in tests). */
  extensionLoadOptions?: LoadOptions;
  /** Test hook: deterministic 'now' for system-prompt assembly. */
  now?: () => Date;
  /** Per-tool execution timeout in ms. */
  toolTimeoutMs?: number;
}

export async function runAgent(
  manifestPath: string,
  options: RunAgentOptions = {},
): Promise<RunningAgent> {
  const resolveOptions: ResolveOptions = { ...(options.resolve ?? {}) };
  if (!resolveOptions.registry) {
    resolveOptions.registry = new LocalRegistry().lookup;
  }

  const preManifest = await parseAgentManifest(manifestPath);
  const ctx: ExtensionContext = {
    manifestDir: path.dirname(preManifest.manifestPath),
    agentName: preManifest.agent.name,
    glassVersion: GLASS_VERSION,
  };

  // Boot extension packages and manifest-declared providers BEFORE the
  // resolver runs so they can claim tool/skill names.
  const extensionProviders = await bootExtensions(preManifest, ctx, options);
  const bootedProviders = await bootProviders(preManifest, ctx);
  const allProviders = [...extensionProviders, ...bootedProviders, ...(options.providers ?? [])];
  if (allProviders.length > 0) {
    resolveOptions.providers = [...(resolveOptions.providers ?? []), ...allProviders];
  }

  const resolved = await resolveAgent(manifestPath, resolveOptions);

  const secrets = await loadSecrets(resolved, options);
  const session = await instantiateSession(resolved, options, ctx);
  const sessionSkills = await collectSessionSkills(session);
  const harness = await instantiateHarness(resolved, options, ctx);

  // Build the tool table: ProcessTool for each declared tool (provider-
  // supplied impls win), plus the privileged in-process variants.
  const toolTable = new ToolTable(
    resolved.tools
      .filter((rt) => !PRIVILEGED_BUILTINS.has(rt.manifest.tool.name))
      .map(
        (rt) =>
          rt.tool ??
          new ProcessTool(rt.manifest, {
            extraPath: resolved.pathAdditions,
            ...(options.toolTimeoutMs ? { timeoutMs: options.toolTimeoutMs } : {}),
          }),
      ),
    secrets,
  );

  const state = new AgentState({
    skills: [...resolved.skills.map((s) => s.manifest), ...sessionSkills],
    ceiling: resolved.manifest.sandbox,
    toolTable,
  });

  // Permission-handler holder shared with privileged in-process tools so
  // setPermissionHandler() at runtime is reflected in their consent calls.
  const permissionHolder: { current: PermissionHandler | null } = {
    current: options.permissionHandler ?? null,
  };

  attachPrivilegedBuiltins({
    resolved,
    state,
    toolTable,
    options,
    resolveOptions,
    allProviders,
    secrets,
    permissionHolder,
  });

  return new RunningAgentImpl({
    resolved,
    secrets,
    session,
    harness,
    state,
    updateSink: new UpdateSink(),
    providers: allProviders,
    permissionHolder,
    ...(options.now ? { now: options.now } : {}),
  });
}

// ─── boot-time helpers ────────────────────────────────────────────────────

async function bootExtensions(
  manifest: import("../types/manifest.js").AgentManifest,
  ctx: ExtensionContext,
  options: RunAgentOptions,
): Promise<Provider[]> {
  const providers: Provider[] = [];
  for (const [pkgName, pkgConfig] of Object.entries(manifest.extensions ?? {})) {
    const { addedProviders } = await loadExtensionPackage(
      pkgName,
      pkgConfig,
      { agentManifestDir: ctx.manifestDir, agentName: ctx.agentName, glassVersion: ctx.glassVersion },
      options.extensionLoadOptions ?? {},
    );
    providers.push(...addedProviders);
  }
  return providers;
}

async function bootProviders(
  manifest: import("../types/manifest.js").AgentManifest,
  ctx: ExtensionContext,
): Promise<Provider[]> {
  const out: Provider[] = [];
  for (const [name, config] of Object.entries(manifest.providers ?? {})) {
    out.push(await getProviderFactory(name).create(config, ctx));
  }
  return out;
}

async function loadSecrets(
  resolved: ResolvedAgent,
  options: RunAgentOptions,
): Promise<Record<string, string>> {
  const stores: SecretsStore[] = [];
  if (options.secrets) stores.push(options.secrets);
  stores.push(new EnvSecretsStore());
  stores.push(
    new FileSecretsStore(path.join(path.dirname(resolved.manifest.manifestPath), ".glass-secrets")),
  );
  const store = new ChainedSecretsStore(stores);

  const requiredNames = [...resolved.requiredSecrets.keys()];
  const ceilingNames = resolved.manifest.sandbox.secrets ?? [];
  const ceilingOnly = ceilingNames.filter((n) => !resolved.requiredSecrets.has(n));

  // Tool-required secrets must resolve (or `allowMissingSecrets`); ceiling-
  // only secrets load best-effort so `secrets.get` can hand them out on demand.
  const required = await resolveSecrets(store, requiredNames, {
    allowMissing: options.allowMissingSecrets ?? false,
  });
  const optional = await resolveSecrets(store, ceilingOnly, { allowMissing: true });
  return { ...required, ...optional };
}

async function instantiateSession(
  resolved: ResolvedAgent,
  options: RunAgentOptions,
  ctx: ExtensionContext,
): Promise<Session> {
  const factory = options.sessionOverride ?? getSessionFactory(resolved.manifest.session.provider);
  const config: Record<string, unknown> = {
    ...resolved.manifest.session,
    ...(options.sessionConfigOverride ?? {}),
  };
  delete config.provider;
  return await factory.create(config, ctx);
}

async function instantiateHarness(
  resolved: ResolvedAgent,
  options: RunAgentOptions,
  ctx: ExtensionContext,
): Promise<import("../types/interfaces.js").Harness> {
  const factory = options.harnessOverride?.factory ?? getHarnessFactory(resolved.manifest.harness.provider);
  const config: Record<string, unknown> = options.harnessOverride?.config
    ? options.harnessOverride.config
    : { ...resolved.manifest.harness, ...(options.harnessConfigOverride ?? {}) };
  delete config.provider;
  return await factory.create(config, ctx);
}

async function collectSessionSkills(session: Session): Promise<SkillManifest[]> {
  if (!session.skills) return [];
  const r = session.skills();
  return Array.isArray(r) ? r : await r;
}

interface AttachBuiltinsArgs {
  resolved: ResolvedAgent;
  state: AgentState;
  toolTable: ToolTable;
  options: RunAgentOptions;
  resolveOptions: ResolveOptions;
  allProviders: Provider[];
  secrets: Record<string, string>;
  permissionHolder: { current: PermissionHandler | null };
}

function attachPrivilegedBuiltins(args: AttachBuiltinsArgs): void {
  const declaredBuiltins = new Set(
    args.resolved.tools
      .map((t) => t.manifest.tool.name)
      .filter((n) => PRIVILEGED_BUILTINS.has(n)),
  );

  // Subagents: union all declared by skills.
  const subagents: Array<{ name: string; ref: ResolvedSubagent; skill: string }> = [];
  for (const sk of args.resolved.skills) {
    for (const [name, ref] of Object.entries(sk.subagents)) {
      subagents.push({ name, ref, skill: sk.manifest.name });
    }
  }
  if (declaredBuiltins.has("spawn_subagent") || subagents.length > 0) {
    args.toolTable.addTool(
      new SpawnSubagentTool(
        new SubagentRegistry(subagents, args.resolved.manifest.sandbox),
        { runOptions: args.options.resolve ? { resolve: args.options.resolve } : {} },
      ),
    );
  }

  if (declaredBuiltins.has("search_skills") || declaredBuiltins.has("add_skill")) {
    const deps: SkillDiscoveryDeps = {
      state: args.state,
      providers: args.allProviders,
      builtinsDir: args.resolveOptions.builtinsDir ?? findBuiltinsDir(import.meta.url),
      requestPermission: async (req) =>
        args.permissionHolder.current
          ? args.permissionHolder.current(req)
          : { decision: "deny" },
      agentName: args.resolved.manifest.agent.name,
      pathAdditions: args.resolved.pathAdditions,
      ...(args.options.toolTimeoutMs ? { toolTimeoutMs: args.options.toolTimeoutMs } : {}),
      loadedSecrets: args.secrets,
    };
    if (declaredBuiltins.has("search_skills")) args.toolTable.addTool(new SearchSkillsTool(deps));
    if (declaredBuiltins.has("add_skill")) args.toolTable.addTool(new AddSkillTool(deps));
  }
}

export { StaticSecretsStore };
