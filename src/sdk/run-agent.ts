/**
 * runAgent — the top-level SDK entry point.
 *
 * Resolves a manifest, loads extensions, fetches secrets, validates
 * capabilities, instantiates session + harness + providers, and returns a
 * RunningAgent SDK handle. Does NOT run a turn — the client triggers
 * turns via `prompt()`.
 *
 * The single source-of-truth for runtime configuration is the manifest:
 * pass either a path or an `AgentManifest` object. The harness's choice
 * of provider plus its config live under `[harness]` (or in the inline
 * spec's `harness` field); same for `[session]`. Tests don't "override" —
 * they construct the manifest they want and pass it in.
 *
 * Secrets pipeline:
 *   1. Each factory (harness / session / provider) declares its required
 *      and optional secret names.
 *   2. Tools declare their secrets via `[tool.secrets]`.
 *   3. The runtime resolves the closure of required names against a
 *      `ChainedSecretsStore` (caller-supplied → env → file). Required
 *      misses fail the run with a clean message; optional misses are
 *      silently skipped.
 *   4. Each component receives ONLY its declared subset at instantiate
 *      time. Implementations never read `process.env` directly.
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
  KeychainSecretsStore,
  StaticSecretsStore,
  XDGSecretsStore,
  type SecretsStore,
} from "../runtime/secrets.js";
import { SecretError } from "../errors.js";
import type {
  ExtensionContext,
  Harness,
  Provider,
  ProviderFactory,
  SecretNeeds,
  Session,
} from "../types/interfaces.js";
import type { PermissionHandler } from "../types/permissions.js";
import type { AgentManifest, SkillManifest } from "../types/manifest.js";

import { RunningAgentImpl, type RunningAgent } from "./running-agent.js";

export const LOOM_VERSION = "0.1.0";

const PRIVILEGED_BUILTINS = new Set(["spawn_subagent", "search_skills"]);

export interface RunAgentOptions {
  resolve?: ResolveOptions;
  /**
   * Highest-priority secret store. Falls through to env + .loom-secrets
   * file if a name isn't found here.
   */
  secrets?: SecretsStore;
  /** If a required secret is missing, omit it rather than throwing. */
  allowMissingSecrets?: boolean;
  /**
   * Last-chance hook for resolving secrets the chain doesn't have. The
   * runtime calls this for each missing required (and missing optional,
   * if the hook chooses to provide one). Returning a string treats the
   * secret as resolved; returning null leaves it missing and the
   * existing failure path runs. The CLI wires this to a TTY readline
   * prompt; programmatic callers can wire it to anything (1Password CLI,
   * a UI, etc.).
   */
  onMissingSecret?: OnMissingSecret;
  /**
   * Programmatic providers — appended to the active provider chain. The
   * SDK consumer constructed these and is responsible for their secrets;
   * the runtime does NOT resolve secrets for instances passed here.
   */
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

  // ─── secret store ─────────────────────────────────────────────────────
  const store = buildSecretStore(preManifest, options);

  // ─── boot extensions: collect provider FACTORIES ──────────────────────
  // Each extension's register() runs once. addProvider(factory) is
  // captured here. Factories are instantiated later, after their declared
  // secrets are resolved.
  const extensionFactories = await collectExtensionFactories(
    preManifest,
    ctx,
    options,
  );

  // ─── phase 1 secrets: harness + session + provider factories ──────
  const phase1Needs = collectFactorySecretNeeds(
    preManifest,
    extensionFactories,
  );
  const phase1Secrets = await loadSecretsBundle(
    store,
    phase1Needs,
    options.allowMissingSecrets ?? false,
    options.onMissingSecret,
  );

  // Instantiate provider factories now (so they're ready for resolveAgent
  // to consult during tool/skill resolution). Each factory gets only its
  // own declared secrets.
  const extensionProviders: Provider[] = [];
  for (const f of extensionFactories) {
    const sub = secretsFor(phase1Secrets, f.secrets);
    extensionProviders.push(await f.create({}, ctx, sub));
  }
  const allProviders = [...extensionProviders, ...(options.providers ?? [])];
  if (allProviders.length > 0) {
    resolveOptions.providers = [
      ...(resolveOptions.providers ?? []),
      ...allProviders,
    ];
  }

  // ─── resolve manifest (validate caps, walk tools) ────────────────────
  const resolved = await resolveAgent(preManifest, resolveOptions);

  // ─── phase 2 secrets: tools ───────────────────────────────────────────────────────
  const toolNeeds = collectToolSecretNeeds(resolved);
  const phase2Secrets = await loadSecretsBundle(
    store,
    toolNeeds,
    options.allowMissingSecrets ?? false,
    options.onMissingSecret,
  );
  const allSecrets = { ...phase1Secrets, ...phase2Secrets };

  // ─── instantiate harness + session with their slices ─────────────────
  const session = await instantiateSession(resolved, ctx, phase1Secrets);
  const sessionSkills = await collectSessionSkills(session);
  const harness = await instantiateHarness(resolved, ctx, phase1Secrets);

  // ─── broker, if any tool wants subagent invocation ───────────────────
  const server = (await maybeStartLoomServer(resolved)) ?? null;
  const skillSubagents = flattenSkillSubagents(resolved.skills);

  // ─── tool table with per-tool secret allowlists ──────────────────────
  const toolTable = new ToolTable(
    resolved.tools
      .filter((rt) => !PRIVILEGED_BUILTINS.has(rt.manifest.name))
      .map((rt) => ({
        tool:
          rt.tool ??
          new ProcessTool(rt.manifest, {
            extraPath: server
              ? [server.binDir, ...resolved.pathAdditions]
              : resolved.pathAdditions,
            ...(options.toolTimeoutMs
              ? { timeoutMs: options.toolTimeoutMs }
              : {}),
            ...(server
              ? { broker: makeBrokerBinding(server, rt, skillSubagents) }
              : {}),
          }),
        // Per-tool allowlist: the union of required + optional declared
        // by the tool's own manifest. The ToolTable filters allSecrets
        // through this set on every execute().
        allowedSecrets: secretAllowlist({
          required: rt.manifest.secrets?.required ?? [],
          optional: rt.manifest.secrets?.optional ?? [],
        }),
      })),
    allSecrets,
  );

  const state = new AgentState({
    skills: [...resolved.skills.map((s) => s.manifest), ...sessionSkills],
    ceiling: resolved.sandbox,
    toolTable,
  });

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
    secrets: allSecrets,
    permissionHolder,
  });

  return new RunningAgentImpl({
    resolved,
    secrets: allSecrets,
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

// ─── secrets pipeline ────────────────────────────────────────────────────

interface SecretRequest {
  name: string;
  required: boolean;
  /** Diagnostic label: "harness:anthropic" / "session:file" / "provider:mcp" / "tool:bash". */
  requestedBy: string;
}

export type OnMissingSecret = (req: {
  name: string;
  /** Comma-joined list of components asking for this secret. */
  requestedBy: string;
  /** True iff at least one requester marked the secret required. */
  required: boolean;
}) => Promise<string | null> | string | null;

/**
 * Default chain priority (first hit wins):
 *   1. caller-supplied store (`options.secrets`)
 *   2. environment
 *   3. XDG: `$XDG_CONFIG_HOME/loom/secrets.toml`
 *   4. macOS Keychain (`security -s loom -a <name>`); silent on other OSes
 *   5. per-agent `.loom-secrets` next to the agent.toml
 *
 * Env beats files so an `ANTHROPIC_API_KEY=... loom run` invocation
 * always wins, but XDG and the Keychain are checked before the
 * per-project file because the per-project file is the most
 * "committed-to-git-by-accident" surface.
 */
function buildSecretStore(
  manifest: AgentManifest,
  options: RunAgentOptions,
): SecretsStore {
  const stores: SecretsStore[] = [];
  if (options.secrets) stores.push(options.secrets);
  stores.push(new EnvSecretsStore());
  stores.push(new XDGSecretsStore());
  stores.push(new KeychainSecretsStore());
  if (manifest.manifestPath) {
    stores.push(
      new FileSecretsStore(
        path.join(path.dirname(manifest.manifestPath), ".loom-secrets"),
      ),
    );
  }
  return new ChainedSecretsStore(stores);
}

/**
 * Phase 1 needs: harness factory + session factory + each extension-added
 * provider factory. Only the factories actually being used contribute.
 *
 * If `harness` or `session` is an instance (not a config record), it was
 * constructed by the caller with its own secret arrangement; the runtime
 * doesn't introspect or resolve.
 */
function collectFactorySecretNeeds(
  manifest: AgentManifest,
  extensionFactories: ProviderFactory[],
): SecretRequest[] {
  const out: SecretRequest[] = [];

  // Harness
  if ("provider" in manifest.harness) {
    const f = getHarnessFactory(manifest.harness.provider);
    pushNeeds(out, f.secrets, `harness:${f.name}`);
  }

  // Session (defaults to memory if absent; default has no secrets)
  if (manifest.session && "provider" in manifest.session) {
    const f = getSessionFactory(manifest.session.provider);
    pushNeeds(out, f.secrets, `session:${f.name}`);
  }

  // Extension-added provider factories
  for (const f of extensionFactories) {
    pushNeeds(out, f.secrets, `provider:${f.name}`);
  }

  return out;
}

function collectToolSecretNeeds(
  resolved: ResolvedAgentManifest,
): SecretRequest[] {
  const out: SecretRequest[] = [];
  for (const t of resolved.tools) {
    for (const name of t.manifest.secrets?.required ?? []) {
      out.push({
        name,
        required: true,
        requestedBy: `tool:${t.manifest.name}`,
      });
    }
    for (const name of t.manifest.secrets?.optional ?? []) {
      out.push({
        name,
        required: false,
        requestedBy: `tool:${t.manifest.name}`,
      });
    }
  }
  return out;
}

function pushNeeds(
  out: SecretRequest[],
  needs: SecretNeeds | undefined,
  requestedBy: string,
): void {
  if (!needs) return;
  for (const name of needs.required ?? [])
    out.push({ name, required: true, requestedBy });
  for (const name of needs.optional ?? [])
    out.push({ name, required: false, requestedBy });
}

async function loadSecretsBundle(
  store: SecretsStore,
  needs: SecretRequest[],
  allowMissingRequired: boolean,
  onMissingSecret: OnMissingSecret | undefined,
): Promise<Record<string, string>> {
  // Required wins on conflict: a name appearing as both required and
  // optional is treated as required (one missing tool failing is louder
  // than another tool quietly missing).
  const required = new Map<string, string[]>(); // name → requesters
  const optional = new Map<string, string[]>();
  for (const r of needs) {
    const target = r.required ? required : optional;
    const arr = target.get(r.name) ?? [];
    arr.push(r.requestedBy);
    target.set(r.name, arr);
  }
  for (const name of required.keys()) optional.delete(name);

  const requiredResolved: Record<string, string> = {};
  const missing: SecretRequest[] = [];
  for (const [name, requesters] of required) {
    const v = await store.get(name);
    if (v !== null) {
      requiredResolved[name] = v;
      continue;
    }
    // Last-chance hook: ask the embedder. CLI wires this to a TTY prompt.
    if (onMissingSecret) {
      const supplied = await Promise.resolve(
        onMissingSecret({
          name,
          requestedBy: [...new Set(requesters)].join(", "),
          required: true,
        }),
      );
      if (typeof supplied === "string" && supplied.length > 0) {
        requiredResolved[name] = supplied;
        continue;
      }
    }
    if (allowMissingRequired) continue;
    for (const r of requesters)
      missing.push({ name, required: true, requestedBy: r });
  }
  if (missing.length > 0) {
    throw new SecretError(formatMissingSecrets(missing));
  }

  const optionalResolved: Record<string, string> = {};
  for (const [name, requesters] of optional) {
    const v = await store.get(name);
    if (v !== null) {
      optionalResolved[name] = v;
      continue;
    }
    if (onMissingSecret) {
      const supplied = await Promise.resolve(
        onMissingSecret({
          name,
          requestedBy: [...new Set(requesters)].join(", "),
          required: false,
        }),
      );
      if (typeof supplied === "string" && supplied.length > 0) {
        optionalResolved[name] = supplied;
      }
    }
  }

  return { ...requiredResolved, ...optionalResolved };
}

function formatMissingSecrets(missing: SecretRequest[]): string {
  // Group by name; list requesters under each.
  const byName = new Map<string, string[]>();
  for (const m of missing) {
    const arr = byName.get(m.name) ?? [];
    arr.push(m.requestedBy);
    byName.set(m.name, arr);
  }
  const lines: string[] = ["Required secrets are not available:"];
  for (const [name, requesters] of byName) {
    lines.push(
      `  - ${name}  (needed by ${[...new Set(requesters)].join(", ")})`,
    );
  }
  lines.push("");
  lines.push(
    "Set them via: an env var (`LOOM_<NAME>` or `<NAME>`); a `.loom-secrets` " +
      "file next to the agent's `agent.toml`; or a custom `SecretsStore` " +
      "passed via `RunAgentOptions.secrets`.",
  );
  return lines.join("\n");
}

/**
 * Filter the loaded-secrets map to only the names a component declared.
 * Used by per-component instantiation and by ToolTable.execute().
 */
export function secretsFor(
  loaded: Record<string, string>,
  needs: SecretNeeds | undefined,
): Record<string, string> {
  if (!needs) return {};
  const allow = secretAllowlist(needs);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(loaded)) {
    if (allow.has(k)) out[k] = v;
  }
  return out;
}

function secretAllowlist(needs: {
  required?: string[];
  optional?: string[];
}): Set<string> {
  return new Set([...(needs.required ?? []), ...(needs.optional ?? [])]);
}

// ─── instantiate harness / session ────────────────────────────────────────

async function instantiateHarness(
  resolved: ResolvedAgentManifest,
  ctx: ExtensionContext,
  phase1Secrets: Record<string, string>,
): Promise<Harness> {
  const spec = resolved.source.harness;
  if ("provider" in spec) {
    const factory = getHarnessFactory(spec.provider);
    const { provider: _p, ...config } = spec;
    const sub = secretsFor(phase1Secrets, factory.secrets);
    return await factory.create(config, ctx, sub);
  }
  return spec;
}

async function instantiateSession(
  resolved: ResolvedAgentManifest,
  ctx: ExtensionContext,
  phase1Secrets: Record<string, string>,
): Promise<Session> {
  const spec = resolved.session;
  if ("provider" in spec) {
    const factory = getSessionFactory(spec.provider);
    const { provider: _p, ...config } = spec;
    const sub = secretsFor(phase1Secrets, factory.secrets);
    return await factory.create(config, ctx, sub);
  }
  return spec;
}

// ─── extensions ──────────────────────────────────────────────────────────

async function collectExtensionFactories(
  manifest: AgentManifest,
  ctx: ExtensionContext,
  options: RunAgentOptions,
): Promise<ProviderFactory[]> {
  const factories: ProviderFactory[] = [];
  for (const [pkgName, pkgConfig] of Object.entries(
    manifest.extensions ?? {},
  )) {
    const { addedProviderFactories } = await loadExtensionPackage(
      pkgName,
      pkgConfig,
      {
        agentManifestDir: ctx.manifestDir,
        agentName: ctx.agentName,
        loomVersion: ctx.loomVersion,
      },
      options.extensionLoadOptions ?? {},
    );
    factories.push(...addedProviderFactories);
  }
  return factories;
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

// ─── session skills ──────────────────────────────────────────────────────

async function collectSessionSkills(
  session: Session,
): Promise<SkillManifest[]> {
  if (!session.skills) return [];
  const r = session.skills();
  return Array.isArray(r) ? r : await r;
}

// ─── privileged builtins ─────────────────────────────────────────────────

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
      // Privileged builtins receive an empty secret allowlist — they
      // operate in-process and don't need the secret bag.
      new Set<string>(),
    );
  }

  if (declaredBuiltins.has("search_skills")) {
    const deps: SkillDiscoveryDeps = {
      state: args.state,
      providers: args.allProviders,
      builtinsDir:
        args.resolveOptions.builtinsDir ?? findBuiltinsDir(import.meta.url),
    };
    args.toolTable.addTool(new SearchSkillsTool(deps), new Set<string>());
  }
}

export { StaticSecretsStore };
