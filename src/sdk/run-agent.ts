/**
 * runAgent — the top-level SDK entry point.
 *
 * Lifecycle:
 *   1. Parse manifest (or accept inline AgentManifest), resolve system_prompt.
 *   2. Build secrets store; load phase-1 secrets (harness/session/provider factory needs).
 *   3. Instantiate harness + session.
 *   4. Build runtime primitives (the methods that flow into ToolContext).
 *   5. Instantiate providers: SDK-supplied → extension-loaded → native (last).
 *      Call optional `provider.init()` on each.
 *   6. Build the flat tool-ref list from top-level `[tools]` (with the
 *      default builtin set when the field is absent).
 *   7. For each `(name, config)` ref, walk providers in order; first
 *      non-null result wins. Throw if no provider claims the name.
 *   8. Phase-2 secrets (per-tool secret needs from resolved Tools).
 *   9. Validate `[capabilities.<name>]` ceilings against each tool's declared caps.
 *  10. Build ToolTable + AgentState + RunningAgent.
 *
 * Tools are JS objects, fully constructed by providers. Loom doesn't
 * sandbox tools at runtime; tools enforce their own declared caps.
 */

import * as path from "node:path";

import { getHarnessFactory, getSessionFactory } from "../extensions/index.js";
import {
  loadExtensionPackage,
  type LoadOptions,
} from "../extensions/loader.js";
import { nativeProviderFactory } from "../extensions/provider/native.js";
import { resolveSystemPrompt } from "../manifest/resolver.js";
import {
  assertKnownKinds,
  assertRequires,
  assertSecretAllowlist,
} from "../manifest/capabilities.js";
import { AgentState } from "../runtime/agent-state.js";
import { ToolTable } from "../runtime/tool-table.js";
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
import { ResolutionError, SecretError } from "../errors.js";
import type {
  Agent,
  ExtensionContext,
  Harness,
  Provider,
  ProviderFactory,
  ProviderInitArgs,
  RuntimePrimitives,
  SecretNeeds,
  Session,
  Tool,
  ToolConfig,
} from "../types/interfaces.js";
import type {
  PermissionHandler,
  PermissionRequest,
  PermissionResult,
} from "../types/permissions.js";
import type { AgentManifest, SessionSpec } from "../types/manifest.js";

import { RunningAgentImpl, type RunningAgent } from "./running-agent.js";

export const LOOM_VERSION = "0.1.0";

const DEFAULT_SESSION = { provider: "memory" } as const;

/**
 * Default top-level tool set when `[tools]` is omitted from the
 * manifest. Each entry resolves through the native provider with
 * empty config; the parallel default capability grants below give
 * each tool a sensible default scope (`./` for FS tools, full env
 * for bash so commands can resolve).
 */
const DEFAULT_TOP_LEVEL_TOOLS: Record<string, ToolConfig> = {
  bash: {},
  read_file: {},
  write_file: {},
  find: {},
};

/**
 * Default per-tool capabilities granted alongside the default tool set.
 * Used only when both `[tools]` and `[capabilities]` are absent. When
 * the manifest declares `[tools]` explicitly, no defaults apply on
 * either axis — the manifest is the source of truth.
 *
 * Note: bash gets `subprocess: "*"` and `paths: ["./"]` but no `env`
 * grant, which means bash falls back to its SAFE_DEFAULT_ENV_NAMES
 * list (PATH, HOME, locale, terminal info — no credentials).
 */
const DEFAULT_TOP_LEVEL_CAPABILITIES: Record<
  string,
  import("../types/manifest.js").CapabilitySet
> = {
  bash: { subprocess: "*", paths: ["./"] },
  read_file: { paths: ["./"] },
  write_file: { paths: ["./"] },
  find: { paths: ["./"] },
};

/** Tool-origin label for tools declared at the top level of agent.toml. */
const TOP_LEVEL_INTRODUCER = "(top-level)";

export interface RunAgentOptions {
  /** Highest-priority secret store; falls through to env/XDG/keychain/file. */
  secrets?: SecretsStore;
  /** If a required secret is missing, omit it rather than throwing. */
  allowMissingSecrets?: boolean;
  /** Last-chance hook called when the secrets chain misses. */
  onMissingSecret?: OnMissingSecret;
  /**
   * Programmatic provider instances — added BEFORE extension-loaded and
   * native. The SDK consumer constructed these and is responsible for
   * their trust class; loom does not resolve secrets for raw instances.
   */
  providers?: Provider[];
  /** Capability-expansion / consent gate. Defaults to deny-all. */
  permissionHandler?: PermissionHandler;
  /** Extension-package search-path overrides (used in tests). */
  extensionLoadOptions?: LoadOptions;
  /** Test hook: deterministic 'now' for system-prompt assembly. */
  now?: () => Date;
  /**
   * Parent agent, when this `runAgent()` call is constructing a
   * sub-agent. Forwarded to harness/session factories as their
   * optional 4th `parent` arg, exposed to the child's tools as
   * `ctx.agent` (the *child* agent) plus available for
   * parent-derived providers (`fork-of-parent`, etc.) to read off
   * `parent.harness` / `parent.session`.
   *
   * Top-level `runAgent` calls leave this undefined. SDK consumers
   * spawning a sub-agent from inside a tool typically use
   * `ctx.spawnSubagent(...)` rather than calling `runAgent` directly
   * — the helper auto-fills `parent` with `ctx.agent`.
   */
  parent?: Agent;
}

export type OnMissingSecret = (req: {
  name: string;
  /** Comma-joined list of components asking for this secret. */
  requestedBy: string;
  /** True iff at least one requester marked the secret required. */
  required: boolean;
}) => Promise<string | null> | string | null;

export async function runAgent(
  source: string | AgentManifest,
  options: RunAgentOptions = {},
): Promise<RunningAgent> {
  // ─── 1. Parse + system prompt ───────────────────────────────────────
  const manifest =
    typeof source === "string"
      ? await (await import("../manifest/parser.js")).parseAgentManifest(source)
      : source;
  const baseDir = manifest.manifestPath
    ? path.dirname(manifest.manifestPath)
    : process.cwd();
  const systemPrompt = await resolveSystemPrompt(manifest, baseDir);

  const extensionCtx: ExtensionContext = {
    manifestDir: baseDir,
    agentName: manifest.name,
    loomVersion: LOOM_VERSION,
  };

  // ─── 2. Secrets store ───────────────────────────────────────────────
  const store = buildSecretStore(manifest, options);

  // ─── 3. Phase-1 secrets ─────────────────────────────────────────────
  const extensionFactories = await collectExtensionFactories(
    manifest,
    extensionCtx,
    options,
  );
  const phase1Needs = collectPhase1SecretNeeds(manifest, extensionFactories);
  const phase1Secrets = await loadSecretsBundle(
    store,
    phase1Needs,
    options.allowMissingSecrets ?? false,
    options.onMissingSecret,
  );

  // ─── 4. Harness + session ─────────────────────────────────
  const harness = await instantiateHarness(
    manifest,
    extensionCtx,
    phase1Secrets,
    options.parent,
  );
  const session = await instantiateSession(
    manifest,
    extensionCtx,
    phase1Secrets,
    options.parent,
  );
  // Per-turn session hooks (`prepareTurn`, `systemPromptSection`)
  // receive an `Agent` ref directly when they're called — nothing is
  // bound at boot. RunningAgentImpl builds the ref on each prompt()
  // and passes it through.

  // The owning `Agent` ref. Stable across turns; the harness/session
  // refs in it are the same instances RunningAgent uses. Tools see a
  // tool-scoped variant via `ctx.agent`; providers receive this
  // ref directly via `resolveTool(name, config, agent)`.
  const ownAgent: Agent = {
    harness,
    session,
    systemPromptCore: systemPrompt,
    agentName: manifest.name,
    ...(manifest.description ? { agentDescription: manifest.description } : {}),
  };

  // ─── 5. Runtime services ────────────────────────────────
  const permissionHolder: { current: PermissionHandler | null } = {
    current: options.permissionHandler ?? null,
  };
  const runtimeServices = new RuntimeServicesImpl(permissionHolder);
  const runtime: RuntimePrimitives = runtimeServices;

  // ─── 6. Instantiate providers ───────────────────────────────────────
  const providers: Array<{
    name: string;
    instance: Provider;
    secrets: Record<string, string>;
    config: Record<string, unknown>;
  }> = [];
  for (const inst of options.providers ?? []) {
    providers.push({
      name: "(sdk-provider)",
      instance: inst,
      secrets: {},
      config: {},
    });
  }
  for (const f of extensionFactories) {
    providers.push({
      name: f.factory.name,
      instance: f.factory.create(),
      secrets: secretsFor(phase1Secrets, f.factory.secrets),
      config: f.config,
    });
  }
  providers.push({
    name: nativeProviderFactory.name,
    instance: nativeProviderFactory.create(),
    secrets: {},
    config: {},
  });

  // ─── 7. Init each provider ──────────────────────────────────────────
  for (const p of providers) {
    if (!p.instance.init) continue;
    const initArgs: ProviderInitArgs = {
      manifest,
      config: p.config,
      secrets: p.secrets,
      extensionContext: extensionCtx,
      runtime,
    };
    await Promise.resolve(p.instance.init(initArgs));
  }

  // ─── 8. Build flat tool-ref list ───────────────────────
  // Top-level [tools] (with defaults if absent), then anything the
  // session contributes via `session.tools()`. Sessions composed via
  // ChainedSession aggregate their children's tools internally before
  // we see the result here.
  const topLevelSpec = manifest.tools ?? DEFAULT_TOP_LEVEL_TOOLS;
  // When the manifest declares neither [tools] nor [capabilities], use
  // the default-tool capability bundle. When it declares [tools], the
  // manifest's [capabilities] table (or empty) is the source of truth.
  const effectiveCapabilities: import("../types/manifest.js").Capabilities =
    manifest.tools === undefined && manifest.capabilities === undefined
      ? DEFAULT_TOP_LEVEL_CAPABILITIES
      : (manifest.capabilities ?? {});
  const refs: Array<{ name: string; config: ToolConfig; origin: string }> = [];
  for (const [name, config] of Object.entries(topLevelSpec)) {
    refs.push({ name, config, origin: TOP_LEVEL_INTRODUCER });
  }
  const sessionTools = (await session.tools?.()) ?? [];
  for (const ref of sessionTools) {
    refs.push({
      name: ref.name,
      config: ref.config,
      origin: "(session)",
    });
  }

  // ─── 9. Resolve each ref through the provider chain ────────────
  // ─── 9. Resolve each ref through the provider chain ────
  const resolvedTools = new Map<string, Tool>();
  for (const ref of refs) {
    let claimed: Tool | null = null;
    const grant = effectiveCapabilities[ref.name];
    for (const p of providers) {
      const result = await Promise.resolve(
        p.instance.resolveTool(ref.name, ref.config, ownAgent, grant),
      );
      if (result) {
        claimed = result;
        break;
      }
    }
    if (!claimed) {
      throw new ResolutionError(
        `Tool '${ref.name}' (introduced by ${ref.origin}) was not claimed by any provider. Registered providers: ${providers.map((p) => p.name).join(", ")}.`,
      );
    }
    if (claimed.name !== ref.name) {
      throw new ResolutionError(
        `Tool '${ref.name}' was constructed with a mismatched name '${claimed.name}'. Provider must honor the requested name.`,
      );
    }
    resolvedTools.set(ref.name, claimed);
  }

  // ─── 10. Phase-2 secrets ──────────────────────────────────
  const toolNeeds = collectToolSecretNeeds(resolvedTools);
  const phase2Secrets = await loadSecretsBundle(
    store,
    toolNeeds,
    options.allowMissingSecrets ?? false,
    options.onMissingSecret,
  );
  const allSecrets = { ...phase1Secrets, ...phase2Secrets };

  // ─── 11. Validate capability grants + secret allowlist ───────────
  // Three boot guards on the manifest grants:
  //   (a) every kind in a structured grant is one the tool declares
  //       it understands (catches typos / phantom-constraint footguns)
  //   (b) every tool's `requires` kinds are present in its grant
  //   (c) every tool's secret needs fit in [agent].secrets (when set)
  assertKnownKinds(resolvedTools, effectiveCapabilities);
  assertRequires(resolvedTools, effectiveCapabilities);
  assertSecretAllowlist(resolvedTools, manifest.secrets);

  // ─── 12. Build ToolTable + AgentState ─────────────────────
  const toolTable = new ToolTable({
    tools: [...resolvedTools.values()].map((tool) => ({
      tool,
      allowedSecrets: secretAllowlist({
        required: tool.secrets?.required ?? [],
        optional: tool.secrets?.optional ?? [],
      }),
    })),
    secrets: allSecrets,
    contextFactory: {
      build: ({ tool }) => ({
        secrets: {}, // overridden by ToolTable per-call
        abortSignal: runtimeServices.currentAbortSignal(),
        requestPermission: (req) => runtime.requestPermission(req),
        // The Agent ref handed to the tool. Same data as `ownAgent`
        // but with a tool-scoped `spawnSubagent` closure — lookups by
        // name resolve against THIS tool's `dependencies.subagents`.
        agent: agentForTool(ownAgent, tool),
      }),
    },
  });

  const state = new AgentState({
    grants: effectiveCapabilities,
    toolTable,
  });

  return new RunningAgentImpl({
    manifest,
    systemPrompt,
    capabilities: effectiveCapabilities,
    session,
    harness,
    state,
    updateSink: new UpdateSink(),
    secrets: allSecrets,
    providers: providers.map((p) => p.instance),
    permissionHolder,
    runtimeServices,
    ...(options.now ? { now: options.now } : {}),
  });
}

// ─── runtime services (the RuntimePrimitives implementation) ───────────

class RuntimeServicesImpl implements RuntimePrimitives {
  private abortSignal: AbortSignal = new AbortController().signal;

  constructor(
    private readonly permissionHolder: { current: PermissionHandler | null },
  ) {}

  /** Called by RunningAgent at the start of each turn. */
  setAbortSignal(signal: AbortSignal): void {
    this.abortSignal = signal;
  }

  currentAbortSignal(): AbortSignal {
    return this.abortSignal;
  }

  requestPermission(req: PermissionRequest): Promise<PermissionResult> {
    const handler = this.permissionHolder.current;
    if (!handler) return Promise.resolve({ decision: "deny" });
    return Promise.resolve(handler(req));
  }
}

export type { RuntimeServicesImpl };

// ─── secrets pipeline ────────────────────────────────────────────────────

interface SecretRequest {
  name: string;
  required: boolean;
  /** Diagnostic label: "harness:anthropic" / "tool:bash" / "provider:mcp". */
  requestedBy: string;
}

/**
 * Default chain priority (first hit wins):
 *   1. caller-supplied store (`options.secrets`)
 *   2. environment
 *   3. XDG: `$XDG_CONFIG_HOME/loom/secrets.toml`
 *   4. macOS Keychain (silent on other OSes)
 *   5. per-agent `.loom-secrets`
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

function collectPhase1SecretNeeds(
  manifest: AgentManifest,
  extensionFactories: Array<{
    factory: ProviderFactory;
    config: Record<string, unknown>;
  }>,
): SecretRequest[] {
  const out: SecretRequest[] = [];
  if ("provider" in manifest.harness) {
    const f = getHarnessFactory(manifest.harness.provider);
    pushNeeds(out, f.secrets, `harness:${f.name}`);
  }
  if (manifest.session && "provider" in manifest.session) {
    const f = getSessionFactory(manifest.session.provider);
    pushNeeds(out, f.secrets, `session:${f.name}`);
  }
  for (const ef of extensionFactories) {
    pushNeeds(out, ef.factory.secrets, `provider:${ef.factory.name}`);
  }
  return out;
}

function collectToolSecretNeeds(tools: Map<string, Tool>): SecretRequest[] {
  const out: SecretRequest[] = [];
  for (const [name, tool] of tools) {
    for (const s of tool.secrets?.required ?? []) {
      out.push({ name: s, required: true, requestedBy: `tool:${name}` });
    }
    for (const s of tool.secrets?.optional ?? []) {
      out.push({ name: s, required: false, requestedBy: `tool:${name}` });
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
  const required = new Map<string, string[]>();
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
  manifest: AgentManifest,
  ctx: ExtensionContext,
  phase1Secrets: Record<string, string>,
  parent: Agent | undefined,
): Promise<Harness> {
  const spec = manifest.harness;
  if ("provider" in spec) {
    const factory = getHarnessFactory(spec.provider);
    if (factory.requiresParent && !parent) {
      throw new ResolutionError(
        `Harness provider '${factory.name}' requires a parent agent and cannot be used at the top level. Construct it inside a tool/session that spawns this manifest as a sub-agent (e.g. via \`ctx.spawnSubagent(...)\` or \`runAgent(submanifest, { parent })\`).`,
      );
    }
    const { provider: _p, ...config } = spec;
    void _p;
    const sub = secretsFor(phase1Secrets, factory.secrets);
    return await factory.create(config, ctx, sub, parent);
  }
  return spec;
}

async function instantiateSession(
  manifest: AgentManifest,
  ctx: ExtensionContext,
  phase1Secrets: Record<string, string>,
  parent: Agent | undefined,
): Promise<Session> {
  const spec: SessionSpec = manifest.session ?? { ...DEFAULT_SESSION };
  if ("provider" in spec) {
    const factory = getSessionFactory(spec.provider);
    if (factory.requiresParent && !parent) {
      throw new ResolutionError(
        `Session provider '${factory.name}' requires a parent agent and cannot be used at the top level. Construct it inside a tool/session that spawns this manifest as a sub-agent (e.g. via \`ctx.spawnSubagent(...)\` or \`runAgent(submanifest, { parent })\`).`,
      );
    }
    const { provider: _p, ...config } = spec;
    void _p;
    const sub = secretsFor(phase1Secrets, factory.secrets);
    return await factory.create(config, ctx, sub, parent);
  }
  return spec;
}

/**
 * Build a tool-scoped Agent ref — same data as the caller's
 * `ownAgent`, but with a `spawnSubagent` method whose lookup scope is
 * THIS tool's `dependencies.subagents`. The runtime hands this to
 * tools as `ctx.agent`; the same Agent ref also flows out as `parent`
 * when the tool spawns a child via `ctx.agent.spawnSubagent(...)`.
 *
 * Recursion-friendly: the spawned `RunningAgent` is itself a fresh
 * call into `runAgent`, with its own provider chain and tool
 * registry. No fan-up of updates; no cascade-cancellation.
 */
function agentForTool(base: Agent, tool: Tool): Agent {
  const ref: Agent = {
    ...base,
    spawnSubagent: (nameOrManifest) =>
      spawnSubagentInScope(
        nameOrManifest,
        tool.dependencies?.subagents ?? [],
        `Tool '${tool.name}'`,
        ref,
      ),
  };
  return ref;
}

/**
 * Build a session-scoped Agent ref — same data as `ownAgent`, but
 * with a `spawnSubagent` whose lookup scope is THIS session's
 * `dependencies.subagents`. RunningAgent hands this to session hooks
 * (`prepareTurn`, `systemPromptSection`).
 */
export function agentForSession(base: Agent, session: Session): Agent {
  const ref: Agent = {
    ...base,
    spawnSubagent: (nameOrManifest) =>
      spawnSubagentInScope(
        nameOrManifest,
        session.dependencies?.subagents ?? [],
        `Session '${base.agentName}'`,
        ref,
      ),
  };
  return ref;
}

async function spawnSubagentInScope(
  nameOrManifest: string | AgentManifest,
  declared: AgentManifest[],
  who: string,
  parent: Agent,
): Promise<RunningAgent> {
  let submanifest: AgentManifest;
  if (typeof nameOrManifest === "string") {
    const found = declared.find((m) => m.name === nameOrManifest);
    if (!found) {
      const have = declared.map((m) => m.name).join(", ") || "(none)";
      throw new ResolutionError(
        `${who} tried to spawn sub-agent '${nameOrManifest}', but its \`dependencies.subagents\` declares: ${have}. Lookups are scoped to the caller's own deps — there is no global registry. Either add the manifest to \`dependencies.subagents\` (so audit can see it) or pass the manifest object inline.`,
      );
    }
    submanifest = found;
  } else {
    submanifest = nameOrManifest;
  }
  return runAgent(submanifest, { parent });
}

// ─── extensions ──────────────────────────────────────────────────────────

async function collectExtensionFactories(
  manifest: AgentManifest,
  ctx: ExtensionContext,
  options: RunAgentOptions,
): Promise<
  Array<{ factory: ProviderFactory; config: Record<string, unknown> }>
> {
  const factories: Array<{
    factory: ProviderFactory;
    config: Record<string, unknown>;
  }> = [];
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
    for (const f of addedProviderFactories) {
      factories.push({ factory: f, config: pkgConfig });
    }
  }
  return factories;
}

export { StaticSecretsStore };
