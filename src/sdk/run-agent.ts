import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findToolsFactory,
  getHarnessFactory,
  getSessionFactory,
} from "../builtins/index.js";
import type { LoadOptions } from "../providers/loader.js";
import {
  DEFAULT_CLIENT_ACP_CAPABILITIES,
  type ClientAcpCapabilities,
} from "../runtime/acp-capabilities.js";
import {
  buildNativeTools,
  nativeBuiltinNames,
} from "../builtins/tools/native.js";
import {
  DEFAULT_BUILTIN_TOOLS,
  isPreBuiltSessionLayer,
  resolveManifest,
  resolveSystemPrompt,
  sourceSpecKey,
  type HarnessBinding,
  type ProviderInstance,
  type ResolvedManifest,
  type ResolvedSessionLayer,
  type SessionBinding,
  type ToolBinding,
} from "../manifest/resolver.js";
import { ceilingEntryFor, collectToolGroups } from "../manifest/tool-groups.js";
import { planToolGroups } from "../manifest/ceiling.js";
import {
  instantiateFromBinding,
  loadManifestProviders,
  lookupFactoryByBinding,
  materialiseTools,
  type ToolsIndex,
} from "../runtime/boot.js";
import { resolveAgentStorage } from "../runtime/storage.js";
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
import type { ClientBridge } from "../runtime/client-bridge.js";
import type {
  AgentManifest,
  Capabilities,
  CapabilitySet,
  SessionSpec,
  ToolEntry,
} from "../types/manifest.js";

import { ChainedSession } from "../runtime/session-chain.js";

import { RunningAgentImpl, type RunningAgent } from "./running-agent.js";

export const LOOM_VERSION: string = readLoomVersion();

function readLoomVersion(): string {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const pkgPath = path.resolve(thisFile, "..", "..", "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version) {
      return parsed.version;
    }
  } catch {
    /* fall through */
  }
  return "0.0.0-unknown";
}

const DEFAULT_SESSION_CHAIN: SessionSpec[] = [
  { provider: "skills" },
  { provider: "compacting" },
  { provider: "in-memory" },
];

export interface RunAgentOptions {
  /**
   * Top-priority secret store. Falls through to the local `.loom-secrets`
   * files (manifest dir, then cwd), then env, keychain, and the global
   * `~/.config/loom/secrets.toml`. See {@link buildSecretStore}.
   */
  secrets?: SecretsStore;
  /** Omit missing required secrets instead of throwing. */
  allowMissingSecrets?: boolean;
  /** Last-chance hook when the chain misses. */
  onMissingSecret?: OnMissingSecret;
  /** Extra SDK-supplied Tools instances, each bound to a synthetic source key. */
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
  const manifest = await loadManifest(source);
  const baseDir = manifest.manifestPath
    ? path.dirname(manifest.manifestPath)
    : process.cwd();
  const systemPrompt = await resolveSystemPrompt(manifest, baseDir);
  const storage = await resolveAgentStorage(manifest);
  if (!options.parent) {
    for (const w of storage.warnings) {
      console.warn(`loom storage: ${w}`);
    }
  }
  const factoryCtx: FactoryContext = {
    manifestDir: baseDir,
    agentName: manifest.name,
    loomVersion: LOOM_VERSION,
    clientCapabilities:
      options.clientAcpCapabilities ?? DEFAULT_CLIENT_ACP_CAPABILITIES,
    purpose: "run",
    storage: storage.path,
    metadata: manifest.metadata ?? {},
  };

  const builtinToolNames = new Set(nativeBuiltinNames());
  const resolved = resolveManifest(manifest, { builtinToolNames });

  const { toolsIndex, loadErrors } = await loadManifestProviders(
    resolved,
    factoryCtx,
    {
      ...(options.providerLoadOptions
        ? { loadOptions: options.providerLoadOptions }
        : {}),
    },
  );
  if (loadErrors.size > 0) {
    const [first] = loadErrors.values();
    if (first) throw first;
  }

  const store = buildSecretStore(manifest, options);
  const phase1Needs = collectPhase1SecretNeeds(resolved, toolsIndex);
  const phase1Secrets = await loadSecretsBundle(
    store,
    phase1Needs,
    options.allowMissingSecrets ?? false,
    options.onMissingSecret,
  );

  const harness =
    "provider" in manifest.harness
      ? await instantiateHarness(
          requireHarnessBinding(resolved.harness),
          factoryCtx,
          phase1Secrets,
          options.parent,
        )
      : (manifest.harness as Harness);
  const session =
    manifest.session &&
    !Array.isArray(manifest.session) &&
    !("provider" in manifest.session)
      ? (manifest.session as Session)
      : await instantiateSession(
          resolved.session,
          factoryCtx,
          phase1Secrets,
          options.parent,
        );
  const ownAgent = buildOwnAgent(harness, session, systemPrompt, manifest);

  // Ref-wrapped so the ACP server's bindSession can install them after runAgent returns.
  const permissionHolder = ref<PermissionHandler | null>(
    options.permissionHandler ?? null,
  );
  const clientBridgeHolder = ref<ClientBridge | null>(null);
  const runtimeServices = new RuntimeServicesImpl(
    permissionHolder,
    clientBridgeHolder,
  );

  // Must run after session construction and before binding; grants are fixed
  // from this point on.
  const groups = await collectToolGroups(session);
  const applied = planToolGroups({
    manifest,
    manifestDir: baseDir,
    sessionLayers: resolved.session,
    groups,
    agent: ownAgent,
  });
  const ceiling = applied.ceiling;
  if (!options.parent) {
    for (const verdict of applied.verdicts) {
      if (verdict.accepted) continue;
      for (const d of verdict.declarations.filter((d) => !d.ok)) {
        console.warn(
          `loom tools: ${verdict.label} inactive — '${d.instance}': ${d.reason}` +
            (d.remediation
              ? `\n  to accept, add to [capabilities]:\n    ${d.remediation}`
              : ""),
        );
      }
    }
  }

  const augmented = applied.augmented;
  const resolvedFull = resolveManifest(augmented, { builtinToolNames });
  const { toolsIndex: toolsIndexFull, loadErrors: loadErrorsFull } =
    await loadManifestProviders(resolvedFull, factoryCtx, {
      ...(options.providerLoadOptions
        ? { loadOptions: options.providerLoadOptions }
        : {}),
    });
  if (loadErrorsFull.size > 0) {
    const [first] = loadErrorsFull.values();
    if (first) throw first;
  }

  // Load only names the first pass didn't request, so each miss (and
  // `onMissingSecret`) fires exactly once.
  const phase1Names = new Set(phase1Needs.map((n) => n.name));
  const contributedNeeds = collectPhase1SecretNeeds(
    resolvedFull,
    toolsIndexFull,
  ).filter((n) => !phase1Names.has(n.name));
  const fullPhase1Secrets = {
    ...phase1Secrets,
    ...(await loadSecretsBundle(
      store,
      contributedNeeds,
      options.allowMissingSecrets ?? false,
      options.onMissingSecret,
    )),
  };

  const instances = await materialiseTools_all({
    resolved: resolvedFull,
    toolsIndex: toolsIndexFull,
    sdkTools: options.providers ?? [],
    session,
    harness,
    manifest: augmented,
    factoryCtx,
    phase1Secrets: fullPhase1Secrets,
    runtime: runtimeServices,
    parent: options.parent,
  });

  const { tools: resolvedTools, grants: effectiveCapabilities } =
    await bindTools(resolvedFull.tools, ceiling, ownAgent, instances);

  const phase2Secrets = await loadSecretsBundle(
    store,
    collectToolSecretNeeds(resolvedTools),
    options.allowMissingSecrets ?? false,
    options.onMissingSecret,
  );
  const allSecrets = { ...fullPhase1Secrets, ...phase2Secrets };

  assertKnownKinds(resolvedTools, effectiveCapabilities);
  assertRequires(resolvedTools, effectiveCapabilities);
  assertSecretAllowlist(resolvedTools, manifest.secrets);
  if (!options.skipRuntimeAudit) {
    await runRuntimeAudit(resolvedTools, options.onAuditFinding);
  }

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
    capabilities: ceiling,
    toolVerdicts: applied.verdicts,
    session,
    harness,
    state,
    updateSink: new UpdateSink(),
    secrets: allSecrets,
    providers: instances.map((i) => i.tools),
    permissionHolder,
    clientBridgeHolder,
    runtimeServices,
  });
}

async function loadManifest(
  source: string | AgentManifest,
): Promise<AgentManifest> {
  if (typeof source !== "string") return source;
  const { parseAgentManifest } = await import("../manifest/parser.js");
  return parseAgentManifest(source);
}

function buildOwnAgent(
  harness: Harness,
  session: Session,
  systemPrompt: string,
  manifest: AgentManifest,
): Agent {
  return {
    manifest,
    harness,
    session,
    systemPromptCore: systemPrompt,
  };
}

interface MaterialisedTools {
  id: string;
  tools: Tools;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  contributionName: string;
}

function sessionAsTools(session: Session): Tools {
  return {
    async resolveTool(name, config, agent, capabilities) {
      if (!session.resolveTool) return null;
      return Promise.resolve(
        session.resolveTool(name, config, agent, capabilities),
      );
    },
  };
}

function harnessAsTools(harness: Harness): Tools {
  return {
    async resolveTool(name, config, agent, capabilities) {
      if (!harness.resolveTool) return null;
      return Promise.resolve(
        harness.resolveTool(name, config, agent, capabilities),
      );
    },
  };
}

async function materialiseTools_all(args: {
  resolved: ResolvedManifest;
  toolsIndex: ToolsIndex;
  sdkTools: Tools[];
  session: Session;
  harness: Harness;
  manifest: AgentManifest;
  factoryCtx: FactoryContext;
  phase1Secrets: Record<string, string>;
  runtime: RuntimePrimitives;
  parent: Agent | undefined;
}): Promise<MaterialisedTools[]> {
  const out: MaterialisedTools[] = [];

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
    const peek = peekToolsContribution(args.toolsIndex, instance);
    const merged = mergeSecretNeeds(
      peek?.secrets,
      peek?.instanceSecretNeeds?.(instance.config),
    );
    const secrets = secretsFor(args.phase1Secrets, merged);
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

  out.push({
    id: "(session)",
    tools: sessionAsTools(args.session),
    config: {},
    secrets: {},
    contributionName: "(session)",
  });

  out.push({
    id: "(harness)",
    tools: harnessAsTools(args.harness),
    config: {},
    secrets: {},
    contributionName: "(harness)",
  });

  args.sdkTools.forEach((inst, i) => {
    out.push({
      id: `(sdk-${i})`,
      tools: inst,
      config: {},
      secrets: {},
      contributionName: "(sdk)",
    });
  });

  // Contract: init runs in registration order and must not call runtime methods until all inits return.
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

function peekToolsContribution(
  index: ToolsIndex,
  instance: ProviderInstance,
):
  | {
      secrets?: SecretNeeds;
      instanceSecretNeeds?(
        config: Record<string, unknown>,
      ): SecretNeeds | undefined;
    }
  | undefined {
  if (instance.kind !== "provider") return undefined;
  if (instance.source) {
    const srcKey = sourceSpecKey(instance.source);
    for (const [key, c] of index) {
      if (key.startsWith(`${srcKey}::`)) return c;
    }
    return undefined;
  }
  if (instance.factoryName) {
    return findToolsFactory(instance.factoryName);
  }
  return undefined;
}

async function bindTools(
  bindings: ToolBinding[],
  ceiling: Capabilities,
  ownAgent: Agent,
  instances: MaterialisedTools[],
): Promise<{ tools: Map<string, Tool>; grants: Capabilities }> {
  const byId = new Map<string, MaterialisedTools>(
    instances.map((m) => [m.id, m]),
  );
  const sdkChain = instances.filter((m) => m.id.startsWith("(sdk-"));
  const nativeInstance = instances.find((m) => m.id === "native");

  const resolved = new Map<string, Tool>();
  const grants: Capabilities = {};
  for (const binding of bindings) {
    const inst = byId.get(binding.providerInstanceId);
    if (!inst) {
      throw new ResolutionError(
        `Tool '${binding.toolName}' (${binding.origin}) references Tools ` +
          `instance '${binding.providerInstanceId}', which wasn't materialised. ` +
          `This is a resolver/runtime mismatch.`,
      );
    }
    const grant =
      binding.requestedGrant ??
      ceilingEntryFor(
        ceiling,
        binding.toolName,
        binding.underlyingName ?? binding.toolName,
      )?.grant;
    let tool = await Promise.resolve(
      inst.tools.resolveTool(
        binding.toolName,
        binding.toolConfig,
        ownAgent,
        grant,
      ),
    );
    if (!tool) {
      const fallbackChain: MaterialisedTools[] = [];
      if (binding.providerInstanceId === "(session)") {
        if (nativeInstance) fallbackChain.push(nativeInstance);
        fallbackChain.push(...sdkChain);
      } else if (binding.providerInstanceId === "native") {
        fallbackChain.push(...sdkChain);
      }
      for (const fallback of fallbackChain) {
        tool = await Promise.resolve(
          fallback.tools.resolveTool(
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
    if (grant !== undefined) grants[binding.toolName] = grant;
  }
  return { tools: resolved, grants };
}

async function instantiateHarness(
  binding: HarnessBinding,
  factoryCtx: FactoryContext,
  phase1Secrets: Record<string, string>,
  parent: Agent | undefined,
): Promise<Harness> {
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
  layers: ResolvedSessionLayer[] | undefined,
  factoryCtx: FactoryContext,
  phase1Secrets: Record<string, string>,
  parent: Agent | undefined,
): Promise<Session> {
  const effective: ResolvedSessionLayer[] =
    layers && layers.length > 0
      ? layers
      : DEFAULT_SESSION_CHAIN.map(
          (spec): SessionBinding => ({
            factoryName: spec.provider as string,
            config: {},
          }),
        );

  const instances: Session[] = [];
  let hasStorageLayer = false;
  for (const layer of effective) {
    if (isPreBuiltSessionLayer(layer)) {
      instances.push(layer.instance);
      hasStorageLayer = true;
      continue;
    }
    const factory = lookupFactoryByBinding(
      layer.factoryName,
      layer.source,
      getSessionFactory,
    );
    if (!factory.passThrough) hasStorageLayer = true;
    const { instance } = await instantiateFromBinding<Session>(
      layer,
      () => factory,
      factoryCtx,
      secretsFor(phase1Secrets, factory.secrets),
      parent,
      "session",
    );
    instances.push(instance);
  }
  // An all-pass-through chain retains no events, so every turn sees an empty history; fail fast.
  if (!hasStorageLayer) {
    const factoryNames = effective
      .filter((l): l is SessionBinding => !isPreBuiltSessionLayer(l))
      .map((l) => l.factoryName);
    throw new ResolutionError(
      `Every session layer in this manifest is pass-through ` +
        `(${factoryNames.map((n) => `'${n}'`).join(", ")}). Pass-through ` +
        `layers transform / adorn events but don't retain them; without ` +
        `a storage layer (e.g. \`in-memory\` or \`file\`) the chain has ` +
        `nowhere for events to live and every turn would see an empty ` +
        `history. Add a storage layer to the end of your \`[session]\` ` +
        `(or \`session.layers\`) block.`,
    );
  }
  if (instances.length === 1) {
    const [only] = instances as [Session];
    return only;
  }
  return new ChainedSession(instances);
}

function requireHarnessBinding(
  binding: HarnessBinding | undefined,
): HarnessBinding {
  if (!binding) {
    throw new Error(
      "runAgent: harness binding missing despite spec-form manifest.harness",
    );
  }
  return binding;
}

interface SecretRequest {
  name: string;
  required: boolean;
  requestedBy: string;
}

/** A secret store in the resolution chain, paired with a human label. */
export interface LabeledSecretStore {
  label: string;
  store: SecretsStore;
}

/**
 * The ordered secret-store tiers, highest priority first. Dotenv-style: the
 * most local, explicit source wins (manifest-dir `.loom-secrets` over ambient
 * env vars). Single source of truth for {@link buildSecretStore} and `loom audit`.
 */
export function describeSecretStores(
  manifest: AgentManifest,
  options: RunAgentOptions,
): LabeledSecretStore[] {
  const tiers: LabeledSecretStore[] = [];
  if (options.secrets) {
    tiers.push({ label: "SDK-supplied store", store: options.secrets });
  }

  const seenFiles = new Set<string>();
  const pushFile = (label: string, filePath: string): void => {
    if (seenFiles.has(filePath)) return;
    seenFiles.add(filePath);
    tiers.push({ label, store: new FileSecretsStore(filePath) });
  };
  if (manifest.manifestPath) {
    pushFile(
      ".loom-secrets (manifest dir)",
      path.join(path.dirname(manifest.manifestPath), ".loom-secrets"),
    );
  }
  pushFile(".loom-secrets (cwd)", path.join(process.cwd(), ".loom-secrets"));

  tiers.push({ label: "environment", store: new EnvSecretsStore() });
  tiers.push({ label: "macOS keychain", store: new KeychainSecretsStore() });
  tiers.push({
    label: "~/.config/loom/secrets.toml",
    store: new XDGSecretsStore(),
  });
  return tiers;
}

export function buildSecretStore(
  manifest: AgentManifest,
  options: RunAgentOptions,
): SecretsStore {
  return new ChainedSecretsStore(
    describeSecretStores(manifest, options).map((tier) => tier.store),
  );
}

export function collectPhase1SecretNeeds(
  resolved: ResolvedManifest,
  toolsIndex: ToolsIndex,
): SecretRequest[] {
  const out: SecretRequest[] = [];
  if (resolved.harness) {
    try {
      const f = lookupFactoryByBinding(
        resolved.harness.factoryName,
        resolved.harness.source,
        getHarnessFactory,
      );
      pushNeeds(out, f.secrets, `harness:${f.name}`);
    } catch {
      // Surfaced later by instantiateHarness.
    }
  }
  for (const layer of resolved.session ?? []) {
    if (isPreBuiltSessionLayer(layer)) continue;
    try {
      const f = lookupFactoryByBinding(
        layer.factoryName,
        layer.source,
        getSessionFactory,
      );
      pushNeeds(out, f.secrets, `session:${f.name}`);
    } catch {
      // Surfaced later by instantiateSession.
    }
  }
  for (const instance of resolved.providers) {
    if (instance.kind === "native") continue;
    let contribution:
      | {
          name: string;
          secrets?: SecretNeeds;
          instanceSecretNeeds?(
            config: Record<string, unknown>,
          ): SecretNeeds | undefined;
        }
      | undefined;
    if (instance.source) {
      const srcKey = sourceSpecKey(instance.source);
      for (const [key, c] of toolsIndex) {
        if (!key.startsWith(`${srcKey}::`)) continue;
        contribution = c;
        break;
      }
    } else if (instance.factoryName) {
      contribution = findToolsFactory(instance.factoryName);
    }
    if (!contribution) continue;
    pushNeeds(out, contribution.secrets, `provider:${contribution.name}`);
    if (contribution.instanceSecretNeeds) {
      pushNeeds(
        out,
        contribution.instanceSecretNeeds(instance.config),
        `provider:${contribution.name}(instance ${instance.id})`,
      );
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

export async function loadSecretsBundle(
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
    "Set them via (highest priority first): a `.loom-secrets` file next to " +
      "the agent's `agent.toml` or in the cwd (`<NAME>=value` per line); an " +
      "env var (`LOOM_<NAME>` or `<NAME>`); the macOS keychain; or " +
      "`~/.config/loom/secrets.toml`. SDK callers can also pass a custom " +
      "`SecretsStore` via `RunAgentOptions.secrets`.",
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

function mergeSecretNeeds(
  a: SecretNeeds | undefined,
  b: SecretNeeds | undefined,
): SecretNeeds | undefined {
  if (!a) return b;
  if (!b) return a;
  const required = [...(a.required ?? []), ...(b.required ?? [])];
  const optional = [...(a.optional ?? []), ...(b.optional ?? [])];
  return {
    ...(required.length ? { required: [...new Set(required)] } : {}),
    ...(optional.length ? { optional: [...new Set(optional)] } : {}),
  };
}

function secretAllowlist(needs: {
  required?: string[];
  optional?: string[];
}): Set<string> {
  return new Set([...(needs.required ?? []), ...(needs.optional ?? [])]);
}

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
      build: ({ tool }) => {
        const bridge = runtimeServices.currentClientBridge();
        return {
          secrets: {}, // overridden by ToolTable per-call
          abortSignal: runtimeServices.currentAbortSignal(),
          requestPermission: (req) => runtimeServices.requestPermission(req),
          agent: agentForTool(ownAgent, tool),
          ...(bridge ? { client: bridge } : {}),
        };
      },
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

class RuntimeServicesImpl implements RuntimePrimitives {
  private abortSignal: AbortSignal = new AbortController().signal;

  constructor(
    private readonly permissionHolder: Ref<PermissionHandler | null>,
    private readonly clientBridgeHolder: Ref<ClientBridge | null>,
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

  currentClientBridge(): ClientBridge | null {
    return this.clientBridgeHolder.current;
  }
}

export type { RuntimeServicesImpl };

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
    who: `Session '${base.manifest.name}'`,
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
