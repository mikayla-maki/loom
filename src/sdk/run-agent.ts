/**
 * runAgent — the top-level SDK entry point.
 *
 * Resolves a manifest, loads extensions, fetches secrets, validates
 * capabilities, instantiates session + harness, and returns a
 * RunningAgent SDK handle. Does NOT run a turn — the client triggers
 * turns via `prompt()`.
 *
 * The single source-of-truth for runtime configuration is the manifest
 * itself: pass either a path or an `AgentManifest` object. The harness's
 * choice of provider plus its config live under `[harness]` (or in the
 * inline spec's `harness` field); same for `[session]`. Tests don't
 * "override" — they construct the manifest they want and pass it in.
 */

import * as path from "node:path";

import { getHarnessFactory, getSessionFactory } from "../extensions/index.js";
import {
  loadExtensionPackage,
  type LoadOptions,
} from "../extensions/loader.js";
import {
  resolveAgent,
  type ResolveOptions,
  type ResolvedAgentManifest,
  type ResolvedSkill,
  type ResolvedSubagent,
  type ResolvedTool,
} from "../manifest/resolver.js";
import { LocalRegistry } from "../registry/registry.js";
import { AgentState } from "../runtime/agent-state.js";
import { findBuiltinsDir } from "../runtime/builtins-dir.js";
import {
  AddSkillTool,
  SearchSkillsTool,
  type SkillDiscoveryDeps,
} from "../runtime/skill-discovery.js";
import {
  ProcessTool,
  ToolTable,
  type BrokerBinding,
} from "../runtime/tool-table.js";
import { LoomServer } from "../server/server.js";
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
  Harness,
  Provider,
  Session,
} from "../types/interfaces.js";
import type { PermissionHandler } from "../types/permissions.js";
import type { AgentManifest, SkillManifest } from "../types/manifest.js";

import { RunningAgentImpl, type RunningAgent } from "./running-agent.js";

export const LOOM_VERSION = "0.1.0";

const PRIVILEGED_BUILTINS = new Set([
  "spawn_subagent",
  "search_skills",
  "add_skill",
]);

export interface RunAgentOptions {
  resolve?: ResolveOptions;
  secrets?: SecretsStore;
  /** If a secret is missing, omit it rather than throwing. */
  allowMissingSecrets?: boolean;
  /** Programmatic providers — appended to manifest [extensions]. */
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
  source: string | AgentManifest,
  options: RunAgentOptions = {},
): Promise<RunningAgent> {
  const resolveOptions: ResolveOptions = { ...(options.resolve ?? {}) };
  if (!resolveOptions.registry) {
    resolveOptions.registry = new LocalRegistry().lookup;
  }

  // Resolve the manifest once. Resolver accepts string | AgentManifest.
  // We need it pre-resolution to bootstrap extensions (they may register
  // tool/skill names that the resolver then sees), so do a lightweight
  // first pass: parse-or-pass, then load extensions, then fully resolve.
  const preManifest =
    typeof source === "string"
      ? await (await import("../manifest/parser.js")).parseAgentManifest(source)
      : source;

  const ctx: ExtensionContext = {
    manifestDir: preManifest.manifestPath
      ? path.dirname(preManifest.manifestPath)
      : process.cwd(),
    agentName: preManifest.name,
    loomVersion: LOOM_VERSION,
  };

  // Boot extensions. Each entry is resolved as either a registered
  // provider factory OR an npm package whose `register()` runs at boot.
  const extensionProviders = await bootExtensions(preManifest, ctx, options);
  const allProviders = [...extensionProviders, ...(options.providers ?? [])];
  if (allProviders.length > 0) {
    resolveOptions.providers = [
      ...(resolveOptions.providers ?? []),
      ...allProviders,
    ];
  }

  const resolved = await resolveAgent(preManifest, resolveOptions);

  const secrets = await loadSecrets(resolved, options);
  const session = await instantiateSession(resolved, ctx);
  const sessionSkills = await collectSessionSkills(session);
  const harness = await instantiateHarness(resolved, ctx);

  // Start the broker server if any non-privileged, non-provider tool
  // declares subagent capability. The privileged spawn_subagent runs
  // in-process and doesn't need the broker.
  const server = (await maybeStartLoomServer(resolved)) ?? null;
  const skillSubagents = flattenSkillSubagents(resolved.skills);

  const toolTable = new ToolTable(
    resolved.tools
      .filter((rt) => !PRIVILEGED_BUILTINS.has(rt.manifest.name))
      .map((rt) => {
        if (rt.tool) return rt.tool;
        return new ProcessTool(rt.manifest, {
          extraPath: server
            ? [server.binDir, ...resolved.pathAdditions]
            : resolved.pathAdditions,
          ...(options.toolTimeoutMs
            ? { timeoutMs: options.toolTimeoutMs }
            : {}),
          ...(server
            ? { broker: makeBrokerBinding(server, rt, skillSubagents) }
            : {}),
        });
      }),
    secrets,
  );

  const state = new AgentState({
    skills: [...resolved.skills.map((s) => s.manifest), ...sessionSkills],
    ceiling: resolved.sandbox,
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
    ...(server ? { server } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

// ─── broker wiring ────────────────────────────────────────────────────────

async function maybeStartLoomServer(
  resolved: ResolvedAgentManifest,
): Promise<LoomServer | null> {
  const needsBroker = resolved.tools.some((t) => {
    if (PRIVILEGED_BUILTINS.has(t.manifest.name)) return false;
    if (t.tool) return false; // provider-supplied; runs in-process
    const sa = t.manifest.capabilities?.subagent;
    return sa === "*" || (Array.isArray(sa) && sa.length > 0);
  });
  if (!needsBroker) return null;
  return await LoomServer.embed();
}

function flattenSkillSubagents(
  skills: ResolvedSkill[],
): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const sk of skills) {
    const reg: Record<string, string> = {};
    for (const [name, ref] of Object.entries(sk.subagents)) {
      reg[name] = subagentRefToString(ref);
    }
    out.set(sk.manifest.name, reg);
  }
  return out;
}

function subagentRefToString(ref: ResolvedSubagent): string {
  switch (ref.kind) {
    case "acp":
      return ref.url;
    case "path":
      return ref.path;
    case "registry":
      return ref.resolvedPath;
  }
}

function makeBrokerBinding(
  server: LoomServer,
  tool: ResolvedTool,
  skillSubagents: Map<string, Record<string, string>>,
): BrokerBinding {
  const skill = tool.introducedBy;
  const registry = skillSubagents.get(skill) ?? {};
  return {
    socketPath: server.socketPath,
    mintToken: () => server.mintToken(skill, registry),
    revokeToken: (t) => server.revokeToken(t),
  };
}

// ─── boot-time helpers ────────────────────────────────────────────────────

async function bootExtensions(
  manifest: AgentManifest,
  ctx: ExtensionContext,
  options: RunAgentOptions,
): Promise<Provider[]> {
  const providers: Provider[] = [];
  for (const [pkgName, pkgConfig] of Object.entries(
    manifest.extensions ?? {},
  )) {
    const { addedProviders } = await loadExtensionPackage(
      pkgName,
      pkgConfig,
      {
        agentManifestDir: ctx.manifestDir,
        agentName: ctx.agentName,
        loomVersion: ctx.loomVersion,
      },
      options.extensionLoadOptions ?? {},
    );
    providers.push(...addedProviders);
  }
  return providers;
}

async function loadSecrets(
  resolved: ResolvedAgentManifest,
  options: RunAgentOptions,
): Promise<Record<string, string>> {
  const stores: SecretsStore[] = [];
  if (options.secrets) stores.push(options.secrets);
  stores.push(new EnvSecretsStore());
  if (resolved.source.manifestPath) {
    stores.push(
      new FileSecretsStore(
        path.join(path.dirname(resolved.source.manifestPath), ".loom-secrets"),
      ),
    );
  }
  const store = new ChainedSecretsStore(stores);

  const requiredNames = [...resolved.requiredSecrets.keys()];
  const ceilingNames = resolved.sandbox.secrets ?? [];
  const ceilingOnly = ceilingNames.filter(
    (n) => !resolved.requiredSecrets.has(n),
  );

  // Tool-required secrets must resolve (or `allowMissingSecrets`); ceiling-
  // only secrets load best-effort so `secrets.get` can hand them out on demand.
  const required = await resolveSecrets(store, requiredNames, {
    allowMissing: options.allowMissingSecrets ?? false,
  });
  const optional = await resolveSecrets(store, ceilingOnly, {
    allowMissing: true,
  });
  return { ...required, ...optional };
}

/**
 * `HarnessSpec = ProviderRefConfig | Harness` is a discriminated union on
 * the presence of `provider: string`. TS narrows on `"provider" in spec`:
 * the true branch is the config form, the false branch is an instance.
 * Same shape applies to `SessionSpec`.
 */
async function instantiateSession(
  resolved: ResolvedAgentManifest,
  ctx: ExtensionContext,
): Promise<Session> {
  const spec = resolved.session;
  if ("provider" in spec) {
    const factory = getSessionFactory(spec.provider);
    const { provider: _p, ...config } = spec;
    return await factory.create(config, ctx);
  }
  return spec;
}

async function instantiateHarness(
  resolved: ResolvedAgentManifest,
  ctx: ExtensionContext,
): Promise<Harness> {
  const spec = resolved.source.harness;
  if ("provider" in spec) {
    const factory = getHarnessFactory(spec.provider);
    const { provider: _p, ...config } = spec;
    return await factory.create(config, ctx);
  }
  return spec;
}

async function collectSessionSkills(
  session: Session,
): Promise<SkillManifest[]> {
  if (!session.skills) return [];
  const r = session.skills();
  return Array.isArray(r) ? r : await r;
}

interface AttachBuiltinsArgs {
  resolved: ResolvedAgentManifest;
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
      .map((t) => t.manifest.name)
      .filter((n) => PRIVILEGED_BUILTINS.has(n)),
  );

  // Subagents: union all declared by skills.
  const subagents: Array<{
    name: string;
    ref: ResolvedSubagent;
    skill: string;
  }> = [];
  for (const sk of args.resolved.skills) {
    for (const [name, ref] of Object.entries(sk.subagents)) {
      subagents.push({ name, ref, skill: sk.manifest.name });
    }
  }
  if (declaredBuiltins.has("spawn_subagent") || subagents.length > 0) {
    args.toolTable.addTool(
      new SpawnSubagentTool(new SubagentRegistry(subagents), {
        runOptions: args.options.resolve
          ? { resolve: args.options.resolve }
          : {},
      }),
    );
  }

  if (
    declaredBuiltins.has("search_skills") ||
    declaredBuiltins.has("add_skill")
  ) {
    const deps: SkillDiscoveryDeps = {
      state: args.state,
      providers: args.allProviders,
      builtinsDir:
        args.resolveOptions.builtinsDir ?? findBuiltinsDir(import.meta.url),
      requestPermission: async (req) =>
        args.permissionHolder.current
          ? args.permissionHolder.current(req)
          : { decision: "deny" },
      agentName: args.resolved.source.name,
      pathAdditions: args.resolved.pathAdditions,
      ...(args.options.toolTimeoutMs
        ? { toolTimeoutMs: args.options.toolTimeoutMs }
        : {}),
      loadedSecrets: args.secrets,
    };
    if (declaredBuiltins.has("search_skills"))
      args.toolTable.addTool(new SearchSkillsTool(deps));
    if (declaredBuiltins.has("add_skill"))
      args.toolTable.addTool(new AddSkillTool(deps));
  }
}

export { StaticSecretsStore };
