/**
 * runAgent — top-level SDK entry point. Turns an agent.toml (or parsed
 * manifest) into a `RunningAgent`.
 *
 * Boot pipeline (v5):
 *   1. Parse manifest → AgentManifest.
 *   2. Resolve manifest → ResolvedManifest (Tools instances,
 *      tool bindings, distinct SourceSpecs, harness/session bindings).
 *   3. Load each distinct provider source (`register()` runs,
 *      contributing Tools / harness / session registrations).
 *   4. Phase-1 secrets (harness + session + Tools contribution needs).
 *   5. Instantiate harness + session from their bindings.
 *   6. Materialise each Tools instance (`contribution.create(config,
 *      ctx, secrets, parent?)`), then `Tools.init()` in registration
 *      order.
 *   7. Bind each tool to its specific Tools instance (no chain;
 *      one Tools instance per tool per the resolver's output).
 *   8. Phase-2 secrets (per-tool needs).
 *   9. Validate `[capabilities]` grants + secret allowlist; runtime audit.
 *  10. Build ToolTable + AgentState + RunningAgent.
 */

import * as path from "node:path";

import { getHarnessFactory, getSessionFactory } from "../builtins/index.js";
import { type LoadOptions } from "../providers/loader.js";
import {
  DEFAULT_CLIENT_ACP_CAPABILITIES,
  type ClientAcpCapabilities,
} from "../runtime/acp-capabilities.js";
import {
  buildNativeTools,
  nativeBuiltinNames,
} from "../builtins/provider/native.js";
import {
  resolveManifest,
  resolveSystemPrompt,
  sourceSpecKey,
  type HarnessBinding,
  type ProviderInstance,
  type ResolvedManifest,
  type SessionBinding,
  type ToolBinding,
} from "../manifest/resolver.js";
import {
  instantiateFromBinding,
  loadManifestProviders,
  lookupFactoryByBinding,
  materialiseTools,
  type ToolsIndex,
} from "../runtime/boot.js";
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
import { CapabilityError, ResolutionError, SecretError } from "../errors.js";
import { ref, type Ref } from "../internal/util.js";
import type {
  Agent,
  AuditFinding,
  FactoryContext,
  Harness,
  InitArgs,
  RuntimePrimitives,
  SecretNeeds,
  Session,
  Tool,
  Tools,
} from "../types/interfaces.js";
import type {
  PermissionHandler,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "../types/permissions.js";
import type {
  AgentManifest,
  Capabilities,
  CapabilitySet,
  SessionSpec,
} from "../types/manifest.js";

import { RunningAgentImpl, type RunningAgent } from "./running-agent.js";

export const LOOM_VERSION = "0.1.0";

const DEFAULT_SESSION: SessionSpec = { provider: "memory" };

/** Default capability grants applied when both `[tools]` and `[capabilities]` are absent. */
const DEFAULT_TOP_LEVEL_CAPABILITIES = {
  bash: { subprocess: "*", paths: ["./"] },
  read_file: { paths: ["./"] },
  write_file: { paths: ["./"] },
  find: { paths: ["./"] },
} as const satisfies Record<string, CapabilitySet>;

export interface RunAgentOptions {
  /** Top-priority secret store; falls through to env/XDG/keychain/file. */
  secrets?: SecretsStore;
  /** Omit missing required secrets instead of throwing. */
  allowMissingSecrets?: boolean;
  /** Last-chance hook when the chain misses. */
  onMissingSecret?: OnMissingSecret;
  /**
   * Extra SDK-supplied Tools instances. Each is bound to a synthetic
   * source key — tools that should route to one of these need a
   * binding wired by the caller (the SDK direct path doesn't use
   * the manifest's `[tools]` `provider` field).
   */
  providers?: Tools[];
  /** Consent gate. Defaults to deny-all. */
  permissionHandler?: PermissionHandler;
  /** Non-error `Tool.audit()` findings. Error findings throw and skip this hook. */
  onAuditFinding?: (
    finding: AuditFinding & { tool: string },
  ) => void | Promise<void>;
  /** Skip per-tool `Tool.audit()`. Static checks still run. */
  skipRuntimeAudit?: boolean;
  /** Provider discovery search-path overrides (tests). */
  providerLoadOptions?: LoadOptions;
  /** Deterministic 'now' for system-prompt assembly (tests). */
  now?: () => Date;
  /** Parent agent when constructing a sub-agent. Undefined at top level. */
  parent?: Agent;
  /** Negotiated ACP client caps. Defaults to `DEFAULT_CLIENT_ACP_CAPABILITIES`. */
  clientAcpCapabilities?: ClientAcpCapabilities;
}

/** Last-chance hook for missing secrets. Return a value or null to skip. */
export type OnMissingSecret = (req: {
  name: string;
  /** Comma-joined list of requesters. */
  requestedBy: string;
  /** True iff at least one requester marked it required. */
  required: boolean;
}) => Promise<string | null> | string | null;

export async function runAgent(
  source: string | AgentManifest,
  options: RunAgentOptions = {},
): Promise<RunningAgent> {
  // 1. Manifest + system prompt + factory context.
  const manifest = await loadManifest(source);
  const baseDir = manifest.manifestPath
    ? path.dirname(manifest.manifestPath)
    : process.cwd();
  const systemPrompt = await resolveSystemPrompt(manifest, baseDir);
  const factoryCtx: FactoryContext = {
    manifestDir: baseDir,
    agentName: manifest.name,
    loomVersion: LOOM_VERSION,
    clientCapabilities:
      options.clientAcpCapabilities ?? DEFAULT_CLIENT_ACP_CAPABILITIES,
  };

  // 2. Resolve manifest to IR. Pure; throws on ambiguity / missing handles.
  const builtinToolNames = new Set(nativeBuiltinNames());
  const resolved = resolveManifest(manifest, { builtinToolNames });

  // 3. Load each distinct provider source. `register()` registers
  //    harness/session factories into the global registries and
  //    returns contributed Tools registrations. The map below keys
  //    contributions by (sourceKey + contributionName) so the
  //    per-instance materialisation can look them up.
  const { toolsIndex, loadErrors } = await loadManifestProviders(
    resolved,
    factoryCtx,
    {
      ...(options.providerLoadOptions
        ? { loadOptions: options.providerLoadOptions }
        : {}),
    },
  );
  // Runtime is strict: any provider load failure aborts boot. (Audit
  // collects these errors and keeps going.)
  if (loadErrors.size > 0) {
    const first = [...loadErrors.entries()][0]!;
    throw first[1];
  }

  // 4. Secrets store + phase-1 needs (harness + session + provider-
  //    contributed Tools registrations this manifest will instantiate).
  const store = buildSecretStore(manifest, options);
  const phase1Secrets = await loadSecretsBundle(
    store,
    collectPhase1SecretNeeds(resolved, toolsIndex),
    options.allowMissingSecrets ?? false,
    options.onMissingSecret,
  );

  // 5. Harness + session + the self-Agent ref tools/providers see.
  //    Pre-built instances pass through unchanged; specs resolve via
  //    factory + config.
  const harness =
    "provider" in manifest.harness
      ? await instantiateHarness(
          resolved.harness!,
          factoryCtx,
          phase1Secrets,
          options.parent,
        )
      : (manifest.harness as Harness);
  const session =
    manifest.session && !("provider" in manifest.session)
      ? (manifest.session as Session)
      : await instantiateSession(
          resolved.session,
          factoryCtx,
          phase1Secrets,
          options.parent,
        );
  const ownAgent = buildOwnAgent(harness, session, systemPrompt, manifest);

  // 6. Runtime services (per-turn abort + permission handler).
  const permissionHolder = ref<PermissionHandler | null>(
    options.permissionHandler ?? null,
  );
  const runtimeServices = new RuntimeServicesImpl(permissionHolder);

  // 7. Materialise + init each Tools instance the resolver asked for.
  //    SDK-supplied Tools instances are appended afterwards under a
  //    synthetic "(sdk)" slot — they don't participate in the
  //    manifest's bindings but are still init'd and closed with the
  //    rest.
  const instances = await materialiseTools_all({
    resolved,
    toolsIndex,
    sdkTools: options.providers ?? [],
    manifest,
    factoryCtx,
    phase1Secrets,
    runtime: runtimeServices,
    parent: options.parent,
  });

  // 8. Bind tools (manifest [tools] → resolver bindings + session.tools()).
  //    Each binding maps to a single provider instance by id.
  const effectiveCapabilities = effectiveCapabilitiesFor(manifest);
  const sessionToolBindings = await collectSessionToolBindings(session);
  const allBindings: ToolBinding[] = [
    ...resolved.tools,
    ...sessionToolBindings,
  ];
  const resolvedTools = await bindTools(
    allBindings,
    effectiveCapabilities,
    ownAgent,
    instances,
  );

  // 9. Phase-2 secrets (per-tool needs).
  const phase2Secrets = await loadSecretsBundle(
    store,
    collectToolSecretNeeds(resolvedTools),
    options.allowMissingSecrets ?? false,
    options.onMissingSecret,
  );
  const allSecrets = { ...phase1Secrets, ...phase2Secrets };

  // 10. Validate grants + secret allowlist; runtime tool audit.
  assertKnownKinds(resolvedTools, effectiveCapabilities);
  assertRequires(resolvedTools, effectiveCapabilities);
  assertSecretAllowlist(resolvedTools, manifest.secrets);
  if (!options.skipRuntimeAudit) {
    await runRuntimeAudit(resolvedTools, options.onAuditFinding);
  }

  // 11. ToolTable + AgentState + RunningAgent.
  const toolTable = buildToolTable(
    resolvedTools,
    allSecrets,
    runtimeServices,
    ownAgent,
  );
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
    providers: instances.map((i) => i.tools),
    permissionHolder,
    runtimeServices,
    ...(options.now ? { now: options.now } : {}),
  });
}

// ─── 1. manifest loading ──────────────────────────────────────────────────

async function loadManifest(
  source: string | AgentManifest,
): Promise<AgentManifest> {
  if (typeof source !== "string") return source;
  const { parseAgentManifest } = await import("../manifest/parser.js");
  return parseAgentManifest(source);
}

// ─── self-agent ref ───────────────────────────────────────────────────────

function buildOwnAgent(
  harness: Harness,
  session: Session,
  systemPrompt: string,
  manifest: AgentManifest,
): Agent {
  return {
    harness,
    session,
    systemPromptCore: systemPrompt,
    agentName: manifest.name,
    ...(manifest.description ? { agentDescription: manifest.description } : {}),
  };
}

// ─── 3. provider loading ────────────────────────────────────────────────────

/**
 * Index of provider-contributed Tools registrations, keyed by source
 * + contribution name.
 *
 * Built when we load each distinct SourceSpec the manifest references.
 * `ToolsIndex` is the shared shape (handled by `loadManifestProviders`
 * in `runtime/boot.ts`). Each provider's contributions are indexed
 * both under their declared name AND under the package's default name
 * so the v5 "primary contribution = package name" convention
 * resolves cleanly.
 */

// ─── 7. Tools instance materialisation ──────────────────────────────────

/**
 * Materialised Tools instance — paired with its boot inputs so we
 * can call `init()` and report it back to the RunningAgent for cleanup.
 */
interface MaterialisedTools {
  /** Resolver-assigned id (`"native"`, `"p1"`, `"p2"`, …) or `"(sdk-N)"`. */
  id: string;
  tools: Tools;
  /** Config passed to the contribution's `create()`. */
  config: Record<string, unknown>;
  /** Filtered secrets the contribution asked for. */
  secrets: Record<string, string>;
  /** Contribution name for diagnostics. */
  contributionName: string;
}

async function materialiseTools_all(args: {
  resolved: ResolvedManifest;
  toolsIndex: ToolsIndex;
  sdkTools: Tools[];
  manifest: AgentManifest;
  factoryCtx: FactoryContext;
  phase1Secrets: Record<string, string>;
  runtime: RuntimePrimitives;
  parent: Agent | undefined;
}): Promise<MaterialisedTools[]> {
  const out: MaterialisedTools[] = [];

  // Always materialise the native Tools instance, even when the
  // resolver didn't reference it. It's stateless and cheap;
  // session-contributed tools and SDK-direct paths can route through
  // it without the manifest having an explicit binding.
  const hasNative = args.resolved.providers.some((p) => p.kind === "native");
  if (!hasNative) {
    out.push({
      id: "native",
      tools: buildNativeTools(),
      config: {},
      secrets: {},
      contributionName: "native",
    });
  }

  for (const instance of args.resolved.providers) {
    if (instance.kind === "native") {
      out.push({
        id: instance.id,
        tools: buildNativeTools(),
        config: {},
        secrets: {},
        contributionName: "native",
      });
      continue;
    }
    // Provider-backed instance: shared construction via boot.ts.
    // Filter secrets to what the contribution declared interest in;
    // we need to peek at the contribution first to do this.
    const peek = peekToolsContribution(args.toolsIndex, instance);
    const secrets = secretsFor(args.phase1Secrets, peek?.secrets);
    const { tools, contribution } = await materialiseTools(
      instance,
      args.toolsIndex,
      args.factoryCtx,
      secrets,
      args.parent,
    );
    out.push({
      id: instance.id,
      tools,
      config: instance.config,
      secrets,
      contributionName: contribution.name,
    });
  }

  // SDK-supplied Tools instances are appended; they're addressable only
  // by SDK-direct callers (not by manifest [tools] entries).
  args.sdkTools.forEach((inst, i) => {
    out.push({
      id: `(sdk-${i})`,
      tools: inst,
      config: {},
      secrets: {},
      contributionName: "(sdk)",
    });
  });

  // Init phase. Tools instances must NOT call runtime methods inside
  // their own init(); the contract is "init runs in registration
  // order; runtime methods are usable once all inits have returned."
  for (const m of out) {
    if (!m.tools.init) continue;
    const initArgs: InitArgs = {
      manifest: args.manifest,
      config: m.config,
      secrets: m.secrets,
      factoryContext: args.factoryCtx,
      runtime: args.runtime,
    };
    await Promise.resolve(m.tools.init(initArgs));
  }

  return out;
}

/** Best-effort peek at the contribution registration for a provider instance. */
function peekToolsContribution(
  index: ToolsIndex,
  instance: ProviderInstance,
): { secrets?: SecretNeeds } | undefined {
  if (instance.kind !== "provider" || !instance.source) return undefined;
  const srcKey = sourceSpecKey(instance.source);
  for (const [key, c] of index) {
    if (key.startsWith(`${srcKey}::`)) return c;
  }
  return undefined;
}

// ─── 8. tool binding ──────────────────────────────────────────────────────

/**
 * Per-manifest effective capability set. Defaults apply only when
 * BOTH `[tools]` and `[capabilities]` are absent.
 */
function effectiveCapabilitiesFor(manifest: AgentManifest): Capabilities {
  if (manifest.tools === undefined && manifest.capabilities === undefined) {
    return DEFAULT_TOP_LEVEL_CAPABILITIES;
  }
  return manifest.capabilities ?? {};
}

async function bindTools(
  bindings: ToolBinding[],
  capabilities: Capabilities,
  ownAgent: Agent,
  instances: MaterialisedTools[],
): Promise<Map<string, Tool>> {
  const byId = new Map<string, MaterialisedTools>(
    instances.map((m) => [m.id, m]),
  );
  // SDK-supplied Tools instances act as a fallback chain when the
  // resolver-assigned instance returns null for a tool. This preserves
  // the SDK-direct pattern (caller wires a custom Tools instance,
  // manifest's `[tools]` doesn't specify a `provider` field, custom
  // names get claimed by the SDK Tools) without requiring per-tool
  // bindings.
  const sdkChain = instances.filter((m) => m.id.startsWith("(sdk-"));

  const resolved = new Map<string, Tool>();
  for (const binding of bindings) {
    const inst = byId.get(binding.providerInstanceId);
    if (!inst) {
      throw new ResolutionError(
        `Tool '${binding.toolName}' (${binding.origin}) references Tools ` +
          `instance '${binding.providerInstanceId}', which wasn't materialised. ` +
          `This is a resolver/runtime mismatch.`,
      );
    }
    const grant = capabilities[binding.toolName];
    let tool = await Promise.resolve(
      inst.tools.resolveTool(
        binding.toolName,
        binding.toolConfig,
        ownAgent,
        grant,
      ),
    );
    // Fallback: when the assigned Tools instance declines (likely the
    // native Tools being asked for a non-builtin tool name), walk the
    // SDK-supplied Tools as a chain.
    if (!tool && binding.providerInstanceId === "native") {
      for (const sdk of sdkChain) {
        tool = await Promise.resolve(
          sdk.tools.resolveTool(
            binding.toolName,
            binding.toolConfig,
            ownAgent,
            grant,
          ),
        );
        if (tool) break;
      }
    }
    if (!tool) {
      throw new ResolutionError(
        `Tools instance '${binding.providerInstanceId}' (${inst.contributionName}) ` +
          `did not claim tool '${binding.toolName}' (${binding.origin}). ` +
          `Its resolveTool() returned null. ` +
          (sdkChain.length > 0
            ? `SDK-supplied Tools also declined.`
            : `No SDK Tools instances configured to fall back to.`),
      );
    }
    resolved.set(binding.toolName, tool);
  }
  return resolved;
}

/** Session-contributed tools, fed into the resolver's binding shape. */
async function collectSessionToolBindings(
  session: Session,
): Promise<ToolBinding[]> {
  const tools = (await session.tools?.()) ?? [];
  return tools.map((ref) => ({
    toolName: ref.name,
    providerInstanceId: "native",
    toolConfig: typeof ref.config === "string" ? {} : ref.config,
    origin: "(session)",
  }));
}

// ─── 5. harness + session instantiation ───────────────────────────────────

async function instantiateHarness(
  binding: HarnessBinding,
  factoryCtx: FactoryContext,
  phase1Secrets: Record<string, string>,
  parent: Agent | undefined,
): Promise<Harness> {
  // Two-phase secret filter: look up the factory first (with the
  // package-name fallback in boot.ts), then pass it the secrets
  // it declared interest in. We need a peek-then-create dance
  // because `instantiateFromBinding` takes already-filtered secrets.
  const factory = lookupFactoryByBinding(
    binding.factoryName,
    binding.source,
    getHarnessFactory,
  );
  const { instance } = await instantiateFromBinding<Harness>(
    binding,
    () => factory,
    factoryCtx,
    secretsFor(phase1Secrets, factory.secrets),
    parent,
    "harness",
  );
  return instance;
}

async function instantiateSession(
  binding: SessionBinding | undefined,
  factoryCtx: FactoryContext,
  phase1Secrets: Record<string, string>,
  parent: Agent | undefined,
): Promise<Session> {
  // Default session is the in-process `memory` factory.
  const effective: SessionBinding = binding ?? {
    factoryName: "memory",
    config: {},
  };
  const factory = lookupFactoryByBinding(
    effective.factoryName,
    effective.source,
    getSessionFactory,
  );
  const { instance } = await instantiateFromBinding<Session>(
    effective,
    () => factory,
    factoryCtx,
    secretsFor(phase1Secrets, factory.secrets),
    parent,
    "session",
  );
  return instance;
}

// ─── 4 + 9. secrets pipeline ──────────────────────────────────────────────

interface SecretRequest {
  name: string;
  required: boolean;
  requestedBy: string;
}

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
  resolved: ResolvedManifest,
  toolsIndex: ToolsIndex,
): SecretRequest[] {
  const out: SecretRequest[] = [];
  // Harness factory needs (only when a HarnessBinding is present —
  // pre-built instances bring their own state and don't need secrets
  // resolved at the SDK layer).
  if (resolved.harness) {
    try {
      const f = getHarnessFactory(resolved.harness.factoryName);
      pushNeeds(out, f.secrets, `harness:${f.name}`);
    } catch {
      // Surfaced later by instantiateHarness.
    }
  }
  // Session factory needs.
  if (resolved.session) {
    try {
      const f = getSessionFactory(resolved.session.factoryName);
      pushNeeds(out, f.secrets, `session:${f.name}`);
    } catch {
      // Surfaced later by instantiateSession.
    }
  }
  // Tools-contribution needs (one entry per *distinct* materialised
  // instance — we collect needs per contribution by visiting each
  // instance's source).
  for (const instance of resolved.providers) {
    if (instance.kind === "native") continue;
    if (!instance.source) continue;
    const srcKey = sourceSpecKey(instance.source);
    // Look for any Tools registration for this source; use its
    // secrets as a best-effort approximation.
    for (const [key, contribution] of toolsIndex) {
      if (!key.startsWith(`${srcKey}::`)) continue;
      pushNeeds(out, contribution.secrets, `provider:${contribution.name}`);
      break;
    }
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

// ─── 11. tool table + runtime audit ───────────────────────────────────────

function buildToolTable(
  resolvedTools: Map<string, Tool>,
  allSecrets: Record<string, string>,
  runtimeServices: RuntimeServicesImpl,
  ownAgent: Agent,
): ToolTable {
  return new ToolTable({
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
        requestPermission: (req) => runtimeServices.requestPermission(req),
        agent: agentForTool(ownAgent, tool),
      }),
    },
  });
}

async function runRuntimeAudit(
  tools: Map<string, Tool>,
  onFinding: RunAgentOptions["onAuditFinding"],
): Promise<void> {
  const errors: Array<{ tool: string; finding: AuditFinding }> = [];
  for (const [name, tool] of tools) {
    if (typeof tool.audit !== "function") continue;
    let findings: AuditFinding[] = [];
    try {
      const result = await Promise.resolve(tool.audit());
      if (Array.isArray(result)) findings = result;
    } catch (e) {
      findings = [
        {
          severity: "error",
          message: `tool.audit() threw: ${(e as Error).message}`,
        },
      ];
    }
    for (const finding of findings) {
      if (finding.severity === "error") {
        errors.push({ tool: name, finding });
        continue;
      }
      if (onFinding) {
        await Promise.resolve(onFinding({ tool: name, ...finding }));
      }
    }
  }
  if (errors.length > 0) {
    const summary = errors
      .map((e) => {
        const r = e.finding.remediation
          ? `\n    → ${e.finding.remediation}`
          : "";
        return `  ✗ ${e.tool}: ${e.finding.message}${r}`;
      })
      .join("\n");
    throw new CapabilityError(
      `Runtime environment audit failed for ${errors.length} tool${
        errors.length === 1 ? "" : "s"
      }:\n${summary}`,
      Object.fromEntries(errors.map((e) => [e.tool, e.finding.message])),
      {},
    );
  }
}

// ─── runtime services ─────────────────────────────────────────────────────

class RuntimeServicesImpl implements RuntimePrimitives {
  private abortSignal: AbortSignal = new AbortController().signal;

  constructor(
    private readonly permissionHolder: Ref<PermissionHandler | null>,
  ) {}

  setAbortSignal(signal: AbortSignal): void {
    this.abortSignal = signal;
  }

  currentAbortSignal(): AbortSignal {
    return this.abortSignal;
  }

  requestPermission(
    req: Omit<RequestPermissionRequest, "sessionId">,
  ): Promise<RequestPermissionResponse> {
    const handler = this.permissionHolder.current;
    if (!handler) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    return Promise.resolve(handler(req));
  }
}

export type { RuntimeServicesImpl };

// ─── subagent scope ───────────────────────────────────────────────────────

function agentWithScopedSpawn(
  base: Agent,
  scope: { declared: AgentManifest[]; who: string },
): Agent {
  const scoped: Agent = {
    ...base,
    spawnSubagent: (nameOrManifest) =>
      spawnSubagentInScope(nameOrManifest, scope.declared, scope.who, scoped),
  };
  return scoped;
}

function agentForTool(base: Agent, tool: Tool): Agent {
  return agentWithScopedSpawn(base, {
    declared: tool.dependencies?.subagents ?? [],
    who: `Tool '${tool.name}'`,
  });
}

export function agentForSession(base: Agent, session: Session): Agent {
  return agentWithScopedSpawn(base, {
    declared: session.dependencies?.subagents ?? [],
    who: `Session '${base.agentName}'`,
  });
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
        `${who} tried to spawn sub-agent '${nameOrManifest}', but its ` +
          `\`dependencies.subagents\` declares: ${have}. Lookups are scoped ` +
          `to the caller's own deps — there is no global registry. Either ` +
          `add the manifest to \`dependencies.subagents\` (so audit can ` +
          `see it) or pass the manifest object inline.`,
      );
    }
    submanifest = found;
  } else {
    submanifest = nameOrManifest;
  }
  return runAgent(submanifest, { parent });
}

export { StaticSecretsStore };
