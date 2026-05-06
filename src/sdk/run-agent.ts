/**
 * runAgent — the top-level SDK entry point.
 *
 * Resolves a manifest, loads extensions, walks the skill→tool graph, fetches
 * secrets, validates capabilities, sets up PATH for tool binaries, instantiates
 * the session and harness, and returns a RunningAgent SDK handle. Does NOT
 * run a turn — the client triggers turns via prompt().
 */

import * as path from "node:path";
// path is used below.

import {
  getHarnessFactory,
  getProviderFactory,
  getSessionFactory,
} from "../extensions/index.js";
import { loadExtensionPackage, type LoadOptions } from "../extensions/loader.js";
import { resolveAgent, type ResolveOptions, type ResolvedAgent } from "../manifest/resolver.js";
import { parseAgentManifest } from "../manifest/parser.js";
import { LocalRegistry } from "../registry/registry.js";
import { AgentState } from "../runtime/agent-state.js";
import { AddSkillTool, SearchSkillsTool, type SkillDiscoveryDeps } from "../runtime/skill-discovery.js";
import { fileURLToPath } from "node:url";
import type { Provider } from "../types/interfaces.js";
import type { PermissionHandler } from "../types/permissions.js";
import { RuntimeImpl } from "../runtime/runtime.js";
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
import type { ExtensionContext, Session, SessionFactory, Tool } from "../types/interfaces.js";
import type { SkillManifest } from "../types/manifest.js";

import { RunningAgentImpl, type RunningAgent } from "./running-agent.js";

export const GLASS_VERSION = "0.1.0";

export interface RunAgentOptions {
  /** Resolver options (registry, custom builtins, providers). */
  resolve?: ResolveOptions;
  /** Custom secrets store. Defaults to env + optional secrets file in manifest dir. */
  secrets?: SecretsStore;
  /** If a secret is missing, omit it from the env rather than throwing. */
  allowMissingSecrets?: boolean;
  /** Override the agent's session provider (e.g. tests want memory). */
  sessionOverride?: SessionFactory;
  /** Override the agent's harness provider (e.g. tests want test). */
  harnessOverride?: { factory: import("../types/interfaces.js").HarnessFactory; config?: Record<string, unknown> };
  /** Override the harness config inline (without changing the factory). */
  harnessConfigOverride?: Record<string, unknown>;
  /** Override the session config inline (without changing the factory). */
  sessionConfigOverride?: Record<string, unknown>;
  /**
   * Programmatic provider overrides — appended to whatever the manifest's
   * [providers] table declares. Useful for tests and embedding.
   */
  providers?: Provider[];
  /**
   * Capability-expansion + tool-consent handler. Runtime-mediated operations
   * (most importantly the `add_skill` builtin) call this before granting
   * the agent capabilities outside its declared `[sandbox]`. When omitted,
   * such requests fail closed.
   */
  permissionHandler?: PermissionHandler;
  /**
   * Override the search paths used to resolve `[extensions]` package names.
   * In test contexts this typically points at a fixtures directory that
   * looks like a node_modules tree.
   */
  extensionLoadOptions?: LoadOptions;
  /** For testing: deterministic 'now' used in system-prompt assembly. */
  now?: () => Date;
  /** Per-tool execution timeout in ms (passed through to ProcessTool). */
  toolTimeoutMs?: number;
}

export async function runAgent(
  manifestPath: string,
  options: RunAgentOptions = {},
): Promise<RunningAgent> {
  // Resolve options: if no registry was provided and a registry exists at
  // $GLASS_HOME / ~/.glass, plumb it in so bare names resolve there.
  const resolveOptions: ResolveOptions = { ...(options.resolve ?? {}) };
  if (!resolveOptions.registry) {
    const lr = new LocalRegistry();
    resolveOptions.registry = lr.lookup;
  }

  // Boot providers from the manifest's [providers] table BEFORE resolution
  // so they get a chance to claim tool/skill names. Pre-parse the manifest
  // here just to inspect [providers] and [agent].name; resolveAgent re-parses
  // the manifest internally, which is cheap.
  const preManifest = await parseAgentManifest(manifestPath);

  // Activate npm-installed Glass extension packages BEFORE we resolve
  // anything else. Each listed package's register() may install harness /
  // session / provider factories (named, activated through manifest tables)
  // OR call api.addProvider(...) to auto-activate provider instances for
  // this agent.
  const extensionEntries = Object.entries(preManifest.extensions ?? {});
  const extensionProviders: Provider[] = [];
  for (const [pkgName, pkgConfig] of extensionEntries) {
    const { addedProviders } = await loadExtensionPackage(
      pkgName,
      pkgConfig,
      {
        agentManifestDir: path.dirname(preManifest.manifestPath),
        agentName: preManifest.agent.name,
        glassVersion: GLASS_VERSION,
      },
      options.extensionLoadOptions ?? {},
    );
    extensionProviders.push(...addedProviders);
  }

  const providerEntries = Object.entries(preManifest.providers ?? {});
  const bootedProviders: Provider[] = [];
  if (providerEntries.length > 0) {
    const providerCtx = {
      manifestDir: path.dirname(preManifest.manifestPath),
      agentName: preManifest.agent.name,
      glassVersion: GLASS_VERSION,
    };
    for (const [name, config] of providerEntries) {
      const factory = getProviderFactory(name);
      const inst = await factory.create(config, providerCtx);
      bootedProviders.push(inst);
    }
  }
  // Provider chain priority: extension-auto-added → manifest [providers] →
  // programmatic options.providers. Earlier entries claim names first.
  const allProviders = [
    ...extensionProviders,
    ...bootedProviders,
    ...(options.providers ?? []),
  ];
  if (allProviders.length > 0) {
    resolveOptions.providers = [...(resolveOptions.providers ?? []), ...allProviders];
  }

  const resolved = await resolveAgent(manifestPath, resolveOptions);

  // Secrets store (chained: explicit > env > optional file in manifest dir).
  const stores: SecretsStore[] = [];
  if (options.secrets) stores.push(options.secrets);
  stores.push(new EnvSecretsStore());
  const manifestDir = path.dirname(resolved.manifest.manifestPath);
  stores.push(new FileSecretsStore(path.join(manifestDir, ".glass-secrets")));
  const store = new ChainedSecretsStore(stores);

  // Load every secret named in the agent's [sandbox] ceiling. Tool-required
  // secrets must be present (or `allowMissingSecrets` is set); ceiling-only
  // secrets that aren't strictly required are loaded best-effort (so the
  // builtin `secrets.get` can hand them to the model on demand).
  const requiredSecretNames = Array.from(resolved.requiredSecrets.keys());
  const ceilingSecretNames = resolved.manifest.sandbox.secrets ?? [];
  const ceilingOnly = ceilingSecretNames.filter((n) => !resolved.requiredSecrets.has(n));

  const required = await resolveSecrets(store, requiredSecretNames, {
    allowMissing: options.allowMissingSecrets ?? false,
  });
  const optional = await resolveSecrets(store, ceilingOnly, { allowMissing: true });
  const secrets: Record<string, string> = { ...required, ...optional };

  // Build the subagent registry from each skill's declared subagents. The
  // resolver already validated that the union sits inside the agent's
  // [sandbox].subagent ceiling.
  const subagentEntries: Array<{ name: string; ref: import("../manifest/resolver.js").ResolvedSubagent; skill: string }> = [];
  for (const sk of resolved.skills) {
    for (const [name, ref] of Object.entries(sk.subagents)) {
      subagentEntries.push({ name, ref, skill: sk.manifest.name });
    }
  }
  const subagentRegistry = new SubagentRegistry(
    subagentEntries,
    resolved.manifest.sandbox,
  );

  // Extensions: factories.
  const ctx: ExtensionContext = {
    manifestDir,
    agentName: resolved.manifest.agent.name,
    glassVersion: GLASS_VERSION,
  };

  const sessionFactory = options.sessionOverride
    ? options.sessionOverride
    : getSessionFactory(resolved.manifest.session.provider);
  const sessionConfig: Record<string, unknown> = {
    ...resolved.manifest.session,
    ...(options.sessionConfigOverride ?? {}),
  };
  delete sessionConfig.provider;
  const session = await sessionFactory.create(sessionConfig, ctx);
  const sessionSkills = await collectSessionSkills(session);

  const harnessFactory = options.harnessOverride
    ? options.harnessOverride.factory
    : getHarnessFactory(resolved.manifest.harness.provider);
  const harnessConfig: Record<string, unknown> = options.harnessOverride?.config
    ? options.harnessOverride.config
    : { ...resolved.manifest.harness, ...(options.harnessConfigOverride ?? {}) };
  delete harnessConfig.provider;
  const harness = await harnessFactory.create(harnessConfig, ctx);

  // Tools — provider-supplied tools win over ProcessTool construction. For
  // builtins backed by privileged in-process implementations
  // (spawn_subagent, search_skills, add_skill) we drop the ProcessTool and
  // attach the in-process variant instead. This keeps `requires: builtin`
  // working as the user-facing affordance while routing the actual call
  // through the runtime.
  const PRIVILEGED_BUILTINS = new Set(["spawn_subagent", "search_skills", "add_skill"]);
  const processTools: Tool[] = resolved.tools
    .filter((rt) => !PRIVILEGED_BUILTINS.has(rt.manifest.tool.name))
    .map((rt) => {
      if (rt.tool) return rt.tool;
      return new ProcessTool(rt.manifest, {
        extraPath: resolved.pathAdditions,
        ...(options.toolTimeoutMs ? { timeoutMs: options.toolTimeoutMs } : {}),
      });
    });
  const declaredBuiltins = new Set(
    resolved.tools.map((rt) => rt.manifest.tool.name).filter((n) => PRIVILEGED_BUILTINS.has(n)),
  );
  const tools: Tool[] = [...processTools];
  const toolTable = new ToolTable(tools, secrets);

  // Build AgentState (mutable view onto skills/ceiling/toolTable).
  const state = new AgentState({
    skills: [...resolved.skills.map((s) => s.manifest), ...sessionSkills],
    ceiling: resolved.manifest.sandbox,
    toolTable,
  });

  // spawn_subagent (privileged in-process tool).
  if (declaredBuiltins.has("spawn_subagent") || subagentEntries.length > 0) {
    toolTable.addTool(
      new SpawnSubagentTool(subagentRegistry, {
        runOptions: options.resolve ? { resolve: options.resolve } : {},
      }),
    );
  }
  // Permission handler holder. The RunningAgentImpl writes through this on
  // setPermissionHandler() so the in-process add_skill tool always sees the
  // current handler (e.g. one set after boot by an ACP server).
  const permissionHolder: { current: PermissionHandler | null } = {
    current: options.permissionHandler ?? null,
  };

  // search_skills / add_skill (privileged; gate add through permissionHandler).
  if (declaredBuiltins.has("search_skills") || declaredBuiltins.has("add_skill")) {
    const discoveryDeps: SkillDiscoveryDeps = {
      state,
      providers: allProviders,
      builtinsDir: resolveBuiltinsDir(resolveOptions.builtinsDir),
      requestPermission: async (req) =>
        permissionHolder.current ? permissionHolder.current(req) : { decision: "deny" },
      agentName: resolved.manifest.agent.name,
      pathAdditions: resolved.pathAdditions,
      ...(options.toolTimeoutMs ? { toolTimeoutMs: options.toolTimeoutMs } : {}),
      loadedSecrets: secrets,
    };
    if (declaredBuiltins.has("search_skills")) toolTable.addTool(new SearchSkillsTool(discoveryDeps));
    if (declaredBuiltins.has("add_skill")) toolTable.addTool(new AddSkillTool(discoveryDeps));
  }

  const updateSink = new UpdateSink();

  return new RunningAgentImpl({
    resolved,
    secrets,
    session,
    harness,
    state,
    updateSink,
    providers: allProviders,
    permissionHolder,
    ...(options.now ? { now: options.now } : {}),
  });
}

function resolveBuiltinsDir(override: string | undefined): string {
  if (override) return override;
  // Match resolver.builtinsDir() heuristics — walk up from this module.
  const here = fileURLToPath(import.meta.url);
  let dir = path.dirname(here);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "builtins");
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sync = require("node:fs") as typeof import("node:fs");
      if (sync.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
    dir = path.dirname(dir);
  }
  return path.join(path.dirname(path.dirname(here)), "builtins");
}

async function collectSessionSkills(session: Session): Promise<SkillManifest[]> {
  if (!session.skills) return [];
  const result = session.skills();
  return Array.isArray(result) ? result : await result;
}

// Re-export commonly used helpers
export { RuntimeImpl, UpdateSink, StaticSecretsStore };
