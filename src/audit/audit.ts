/**
 * Static capability audit — instantiates the native Tools against an
 * agent manifest and prints what it would expose. No LLM is ever
 * invoked and no provider code runs side-effectfully; audit is
 * conservative and deterministic. Provider-supplied tools don't
 * appear in the resolved tool list (that would require running Tools
 * init — which can have side effects like opening MCP connections)
 * but they DO appear as `unresolvedTools` and the providers they
 * came from are surfaced in the `providers` view.
 *
 * The tree shows per agent:
 *   - PROVIDERS: every external SourceSpec the manifest pulls in
 *     (named in `[providers]`, or referenced inline via `[tools]` /
 *     `[harness]` / `[session]`)
 *   - GRANTS: per-tool capability grants from `[capabilities]`
 *   - REQUIRES: every kind each native-resolved tool declares it needs
 *   - SECRETS: every secret name any component declares it needs
 *   - SUB-AGENTS: recursive audit trees + capability-ceiling checks
 *
 * v5 capability-ceiling check: every sub-agent's effective grants must
 * be a subset of the parent's. Violations are surfaced as
 * `capabilityCeilingViolations` on the parent tree and as boot errors
 * at runtime (see `manifest-v5.md` §1.6).
 */

import * as path from "node:path";

import {
  resolveManifest,
  resolveSystemPrompt,
  sourceSpecKey,
  type ResolvedSource,
} from "../manifest/resolver.js";
import { getHarnessFactory, getSessionFactory } from "../builtins/index.js";
import {
  buildNativeTools,
  nativeBuiltinNames,
} from "../builtins/provider/native.js";
import { DEFAULT_CLIENT_ACP_CAPABILITIES } from "../runtime/acp-capabilities.js";
import {
  instantiateFromBinding,
  loadManifestProviders,
  lookupFactoryByBinding as bootLookupFactoryByBinding,
  materialiseTools as bootMaterialiseTools,
  defaultProviderName as bootDefaultProviderName,
} from "../runtime/boot.js";
import { ChainedSession } from "../runtime/session-chain.js";
import { LoomError } from "../errors.js";
import { parseAgentManifest } from "../manifest/parser.js";
import { defaultContains } from "../manifest/capabilities.js";
import type {
  AgentManifest,
  Capabilities,
  CapabilitySet,
  SecretAllowlist,
  SourceSpec,
} from "../types/manifest.js";
import type {
  Agent,
  AuditFinding,
  AuditSeverity,
  FactoryContext,
  Harness,
  Session,
  Tool,
  Tools,
  TrustedPath,
} from "../types/interfaces.js";

export interface SecretRequest {
  name: string;
  required: boolean;
  requestedBy: string[];
  /** Whether the manifest's [agent].secrets allowlist permits this name. */
  permittedByAllowlist: boolean;
}

/**
 * A provider reference surfaced in the audit. Always non-empty when
 * any external code is loaded by this manifest; covers both
 * `[providers]`-declared handles and inline references from
 * `[tools]` / `[harness]` / `[session]`.
 */
export interface ProviderSummary {
  /** Canonical structural key (matches `lock.toml`). */
  key: string;
  source: SourceSpec;
  /** Local `[providers]` handle, when declared. */
  handle?: string;
  /** Where in the manifest this provider is referenced. */
  origins: string[];
  /** Set when audit tried to load this provider but couldn't. */
  loadError?: string;
}

/**
 * Audit summary of the manifest's harness (or session). Carries the
 * factory selector, where its code came from (when provider-backed),
 * and whether the factory was found at boot time.
 */
export interface FactoryAuditSummary {
  /** Human-readable label: factory name, provider handle, or "<pre-built instance>". */
  display: string;
  /** Factory name the runtime looked up. Empty for pre-built instances. */
  factoryName?: string;
  /** Factory config (non-secret keys from the `[harness]` / `[session]` block). */
  config: Record<string, unknown>;
  /** SourceSpec key when the factory came from a provider package. */
  providerKey?: string;
  /** Local `[providers]` handle when declared. */
  providerHandle?: string;
  /** True iff the registry knew this factory at audit time. */
  resolved: boolean;
  /** True when the manifest carries a pre-built `Harness`/`Session` instance. */
  preBuilt: boolean;
}

/** Audit-level view of the manifest's session, including its contributions. */
export interface SessionAuditSummary extends FactoryAuditSummary {
  /** Tool names the session contributed via `Session.tools()`. */
  contributedTools: string[];
  /** Filesystem paths declared trusted by the session. */
  trustedPaths: TrustedPath[];
  /** Set when audit tried to construct the session factory but couldn't. */
  constructionError?: string;
}

/**
 * A capability the sub-agent declared but the parent's `[capabilities]`
 * doesn't cover. Surfaced on the *parent* tree; the runtime would
 * reject the sub-agent at spawn time.
 */
export interface CapabilityCeilingViolation {
  /** Which sub-agent (by name + manifest path). */
  subagentName: string;
  subagentManifestPath: string;
  /** The tool key in [capabilities] that the parent doesn't cover. */
  capabilityKey: string;
  /** What the sub-agent asks for. */
  subagentGrant: CapabilitySet;
  /** What the parent grants (may be undefined if the parent grants nothing). */
  parentGrant: CapabilitySet | undefined;
}

export interface CapabilityTree {
  manifestPath: string;
  name: string;
  /** The agent's `[capabilities]` table — per-tool grants. */
  grants: Capabilities;
  /** The agent's `[agent].secrets` allowlist (or undefined when unset). */
  secretAllowlist?: SecretAllowlist;
  /**
   * Every provider (declared or inline) this manifest pulls in.
   * Includes load failures (e.g. `npm install` hasn't run); see
   * `loadError`.
   */
  providers: ProviderSummary[];
  /**
   * Each tool the native Tools could resolve, with its declared
   * capability requires/optionals, the granted set, the source that
   * introduced it, and any sub-agent trees reachable through
   * `tool.dependencies.subagents`.
   */
  tools: Array<{
    name: string;
    requires: string[];
    optional: string[];
    granted: CapabilitySet | undefined;
    missing: string[];
    findings: AuditFinding[];
    introducedBy: string;
    subagents: CapabilityTree[];
    /**
     * SourceSpec key when this tool was claimed by a provider-
     * contributed Tools instance. Absent for native (built-in) tools.
     */
    providerKey?: string;
    /** Local provider handle when declared. */
    providerHandle?: string;
  }>;
  /** Every secret name a component declares it needs. */
  secrets: SecretRequest[];
  /** Sub-agent trees the session declares it may spawn. */
  sessionSubagents: CapabilityTree[];
  /**
   * Tool refs that couldn't be resolved by the native Tools —
   * typically tools whose `provider` resolves to a provider package
   * (audit doesn't instantiate provider Tools).
   */
  unresolvedTools: Array<{ name: string; introducedBy: string }>;
  /**
   * Harness summary — always present (harness is required).
   */
  harness: FactoryAuditSummary;
  /**
   * Session summary for the outermost layer (or the pre-built
   * `Session` instance). Present whenever the manifest declares a
   * `[session]` block or carries a pre-built instance. Absent when
   * the session is omitted entirely (the runtime applies the default
   * chain).
   *
   * For a multi-layer session this describes only the outermost
   * layer; inspect {@link sessionLayers} to walk every layer.
   */
  session?: SessionAuditSummary;
  /**
   * Every layer of the session, outer-to-inner. Present whenever
   * {@link session} is present. Length 1 for the singleton
   * `[session]` form or a pre-built instance; length ≥ 1 for the
   * `[session].layers` form. Each layer carries its own
   * `contributedTools` / `trustedPaths` so audit consumers can see
   * which layer contributed what.
   */
  sessionLayers?: SessionAuditSummary[];
  /**
   * @deprecated Read `session.trustedPaths` instead. Kept at the top
   * level for back-compat; mirrors `session?.trustedPaths ?? []`.
   */
  trustedPaths: TrustedPath[];
  /**
   * @deprecated Read `session.constructionError` instead. Kept at
   * the top level for back-compat; mirrors
   * `session?.constructionError`.
   */
  sessionConstructionError?: string;
  /**
   * Sources audit couldn't load — typically `npm:` packages the user
   * hasn't installed yet. Kept as a separate list (parallel to
   * `providers`) because audit needs to surface the gap distinctly.
   */
  unresolvedSources: Array<{
    spec: string;
    source: SourceSpec;
    reason: string;
  }>;
  /**
   * Capability-ceiling violations against this manifest's direct
   * sub-agents (recursive children are reported on the children
   * themselves). Empty when every sub-agent's capability set is a
   * subset of this manifest's. See §1.6 of manifest-v4.md.
   */
  capabilityCeilingViolations: CapabilityCeilingViolation[];
}

/**
 * Options for {@link auditAgent}.
 */
export interface AuditOptions {
  /**
   * When true, throw a `LoomError` if any non-builtin source can't be
   * loaded (i.e. you haven't run `loom install`). CI uses this; the
   * default (false) keeps audit lenient so dev workflows aren't
   * blocked when packages aren't yet on disk.
   */
  strict?: boolean;
}

const DEFAULT_TOP_LEVEL_CAPABILITIES: Capabilities = {
  bash: { subprocess: "*", paths: ["./"] },
  read_file: { paths: ["./"] },
  write_file: { paths: ["./"] },
  find: { paths: ["./"] },
};

export async function auditAgent(
  source: string | AgentManifest,
  options: AuditOptions = {},
): Promise<CapabilityTree> {
  const tree = await auditAgentInner(source, new Set());
  if (options.strict && tree.unresolvedSources.length > 0) {
    const list = tree.unresolvedSources
      .map((u) => `  - ${u.spec}: ${u.reason}`)
      .join("\n");
    throw new LoomError(
      `loom audit --strict: ${tree.unresolvedSources.length} unresolved source(s) in '${tree.name}'. ` +
        `Run \`loom install\` to materialise them.\n${list}`,
    );
  }
  return tree;
}

async function auditAgentInner(
  source: string | AgentManifest,
  seenManifests: Set<string>,
): Promise<CapabilityTree> {
  const manifest =
    typeof source === "string" ? await parseAgentManifest(source) : source;
  const manifestPath =
    typeof source === "string"
      ? source
      : (source.manifestPath ?? `<inline:${source.name}>`);

  // Cycle detection.
  const cycleKey = manifest.manifestPath ?? `<inline:${manifest.name}>`;
  if (seenManifests.has(cycleKey)) {
    return {
      manifestPath,
      name: manifest.name,
      grants: {},
      providers: [],
      harness: {
        display: "<cycle>",
        config: {},
        resolved: false,
        preBuilt: false,
      },
      tools: [],
      secrets: [],
      sessionSubagents: [],
      unresolvedTools: [{ name: "(cycle)", introducedBy: cycleKey }],
      trustedPaths: [],
      unresolvedSources: [],
      capabilityCeilingViolations: [],
    };
  }
  const nextSeen = new Set(seenManifests);
  nextSeen.add(cycleKey);

  const baseDir = manifest.manifestPath
    ? path.dirname(manifest.manifestPath)
    : process.cwd();
  // Resolve system prompt for parity with runAgent (validates path-form).
  void (await resolveSystemPrompt(manifest, baseDir));

  // ─── resolution ─────────────────────────────────────────────────────
  const builtinToolNames = new Set(nativeBuiltinNames());
  const resolved = resolveManifest(manifest, { builtinToolNames });

  // ─── provider loading (lenient) ───────────────────────────────
  // Same machinery as `runAgent` (via `runtime/boot.js`), but where
  // the runtime treats any provider load failure as fatal, audit
  // collects them in `unresolvedSources` and keeps walking the tree.
  const factoryCtx: FactoryContext = {
    manifestDir: baseDir,
    agentName: manifest.name,
    loomVersion: "audit",
    clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
  };
  const { toolsIndex, loadErrors } = await loadManifestProviders(
    resolved,
    factoryCtx,
  );

  const unresolvedSources: CapabilityTree["unresolvedSources"] = [];
  const providers: ProviderSummary[] = [];
  for (const [key, resolvedSrc] of resolved.sources) {
    const summary: ProviderSummary = {
      key,
      source: resolvedSrc.spec,
      ...(resolvedSrc.handle ? { handle: resolvedSrc.handle } : {}),
      origins: [...resolvedSrc.origins],
    };
    const err = loadErrors.get(key);
    if (err) {
      summary.loadError = err.message;
      unresolvedSources.push({
        spec: key,
        source: resolvedSrc.spec,
        reason: err.message,
      });
    }
    providers.push(summary);
  }
  // Stable order: declared handles first (alphabetically), then inline.
  providers.sort((a, b) => {
    if (a.handle && !b.handle) return -1;
    if (!a.handle && b.handle) return 1;
    return (a.handle ?? a.key).localeCompare(b.handle ?? b.key);
  });

  // ─── session construction (best-effort) ────────────────
  // Instantiate every chain link individually so we can attribute
  // contributed tools and trusted paths to the link that produced
  // them. We also compose them via ChainedSession when there's more
  // than one so the rest of the audit can interact with a uniform
  // session interface (the same way the runtime would). Per-link
  // construction errors are recorded; we continue with the links
  // that did succeed.
  const trustedPaths: TrustedPath[] = [];
  let auditSession: Session | null = null;
  let sessionConstructionError: string | undefined;
  const sessionBindings = resolved.session ?? [];
  /** Tools + trusted paths each link contributed. Aligned with `sessionBindings`. */
  const perLinkContributions: Array<{
    contributedTools: string[];
    trustedPaths: TrustedPath[];
    constructionError?: string;
  }> = [];
  const auditedSessionLinks: Session[] = [];
  for (const [i, binding] of sessionBindings.entries()) {
    let linkInstance: Session | null = null;
    let linkError: string | undefined;
    try {
      const { instance } = await instantiateFromBinding<Session>(
        binding,
        getSessionFactory,
        factoryCtx,
        {},
        undefined,
        "session",
      );
      linkInstance = instance;
      auditedSessionLinks.push(instance);
    } catch (e) {
      linkError = (e as Error).message;
      const linkLabel =
        sessionBindings.length === 1
          ? "session"
          : `session link ${i} ('${binding.factoryName}')`;
      sessionConstructionError =
        (sessionConstructionError ? sessionConstructionError + "; " : "") +
        `${linkLabel}: ${linkError}`;
    }
    perLinkContributions.push({
      contributedTools: [],
      trustedPaths: [],
      ...(linkError ? { constructionError: linkError } : {}),
    });
    void linkInstance; // populated below from per-link queries
  }
  if (auditedSessionLinks.length === 1) {
    auditSession = auditedSessionLinks[0]!;
  } else if (auditedSessionLinks.length > 1) {
    auditSession = new ChainedSession(auditedSessionLinks);
  }

  // Per-link tool / trusted-path discovery. Querying per link lets us
  // attribute contributions to the layer that produced them.
  const sessionToolBindings: typeof resolved.tools = [];
  const claimedSessionTools = new Set(resolved.tools.map((b) => b.toolName));
  let cursor = 0;
  for (const [i, binding] of sessionBindings.entries()) {
    // Find the i'th binding's instance among auditedSessionLinks.
    // perLinkContributions[i].constructionError set ⇒ no instance
    // was created and `cursor` skips it.
    const slot = perLinkContributions[i]!;
    if (slot.constructionError) continue;
    const linkInstance = auditedSessionLinks[cursor++]!;
    const originLabel =
      sessionBindings.length === 1
        ? `(session: ${binding.factoryName})`
        : `(session link ${i}: ${binding.factoryName})`;
    try {
      const refs = (await linkInstance.tools?.()) ?? [];
      for (const ref of refs) {
        slot.contributedTools.push(ref.name);
        if (claimedSessionTools.has(ref.name)) continue;
        claimedSessionTools.add(ref.name);
        sessionToolBindings.push({
          toolName: ref.name,
          // Route through the synthetic `"(session)"` Tools instance
          // (added below) so sessions with their own `resolveTool` get
          // first shot; skills-style sessions fall back to native.
          providerInstanceId: "(session)",
          toolConfig: typeof ref.config === "string" ? {} : ref.config,
          origin: originLabel,
        });
      }
    } catch (e) {
      sessionConstructionError =
        (sessionConstructionError ? sessionConstructionError + "; " : "") +
        `session link ${i} ('${binding.factoryName}') .tools() threw: ${
          (e as Error).message
        }`;
    }
    try {
      const tp = (await linkInstance.trustedPaths?.()) ?? [];
      slot.trustedPaths.push(...tp);
      trustedPaths.push(...tp);
    } catch (e) {
      sessionConstructionError =
        (sessionConstructionError ? sessionConstructionError + "; " : "") +
        `session link ${i} ('${binding.factoryName}') .trustedPaths() threw: ${
          (e as Error).message
        }`;
    }
  }

  // ─── effective grants ───────────────────────────────────────────
  const effectiveGrants: Capabilities =
    manifest.tools === undefined && manifest.capabilities === undefined
      ? DEFAULT_TOP_LEVEL_CAPABILITIES
      : (manifest.capabilities ?? {});

  // ─── tool resolution ──────────────────────────────────
  const native = buildNativeTools();
  const auditAgentRef: Agent = {
    harness: stubHarness(),
    session: stubSession(),
    systemPromptCore: "",
    agentName: manifest.name,
  };

  // Materialise each resolver-determined Tools instance the same way
  // the runtime does (via `materialiseTools` from `boot.ts`).
  // Differences from the runtime: we never call `Tools.init()` (init
  // can have side effects), and we catch construction errors so the
  // rest of the audit tree is still informative. The set we
  // accumulate here is closed at the end of the function for
  // symmetry with the runtime's cleanup path.
  const providerByInstanceId = new Map<string, Tools>();
  const auditedProviderTools: Tools[] = [];
  for (const p of resolved.providers) {
    if (p.kind === "native") {
      providerByInstanceId.set(p.id, native);
      continue;
    }
    try {
      const { tools } = await bootMaterialiseTools(
        p,
        toolsIndex,
        factoryCtx,
        {},
        undefined,
      );
      providerByInstanceId.set(p.id, tools);
      auditedProviderTools.push(tools);
    } catch {
      // No matching Tools contribution (or create() threw). Tools
      // routing through this instance will surface as
      // `unresolvedTools`.
    }
  }

  // Mirror the runtime's synthetic `"(session)"` Tools instance.
  // Sessions with `resolveTool` own the tools they advertise; the
  // skills pattern (advertise without own implementation) falls
  // through to native below.
  if (auditSession) {
    const sess = auditSession;
    providerByInstanceId.set("(session)", {
      async resolveTool(name, config, agent, capabilities) {
        if (!sess.resolveTool) return null;
        return Promise.resolve(
          sess.resolveTool(name, config, agent, capabilities),
        );
      },
    });
  }

  // Index resolved Tools instances by id, so we can attribute each
  // tool to its source provider (when not native).
  const instanceById = new Map<string, (typeof resolved.providers)[number]>();
  for (const p of resolved.providers) instanceById.set(p.id, p);

  const tools: CapabilityTree["tools"] = [];
  const resolvedTools = new Map<string, Tool>();
  const unresolvedTools: CapabilityTree["unresolvedTools"] = [];
  const directSubagentTrees: CapabilityTree[] = [];

  for (const binding of [...resolved.tools, ...sessionToolBindings]) {
    const provider = providerByInstanceId.get(binding.providerInstanceId);
    if (!provider) {
      unresolvedTools.push({
        name: binding.toolName,
        introducedBy: binding.origin,
      });
      continue;
    }
    const grant = effectiveGrants[binding.toolName];
    let t: Tool | null = null;
    try {
      t = await Promise.resolve(
        provider.resolveTool(
          binding.toolName,
          binding.toolConfig,
          auditAgentRef,
          grant,
        ),
      );
    } catch {
      // Tool construction can throw if capabilities are misconfigured;
      // surface as unresolved for audit (the runtime will throw clearer).
      t = null;
    }
    // Mirror the runtime's `"(session)"` → native fallback so the
    // audit sees the same Tool shape the runtime would resolve.
    if (!t && binding.providerInstanceId === "(session)") {
      try {
        t = await Promise.resolve(
          native.resolveTool(
            binding.toolName,
            binding.toolConfig,
            auditAgentRef,
            grant,
          ),
        );
      } catch {
        t = null;
      }
    }
    if (!t) {
      unresolvedTools.push({
        name: binding.toolName,
        introducedBy: binding.origin,
      });
      continue;
    }
    resolvedTools.set(binding.toolName, t);
    // Recurse into the tool's declared sub-agents.
    const subagents: CapabilityTree[] = [];
    for (const sub of t.dependencies?.subagents ?? []) {
      const subTree = await auditAgentInner(sub, nextSeen);
      subagents.push(subTree);
      directSubagentTrees.push(subTree);
    }
    const requires = [...(t.requires ?? [])];
    const optional = [...(t.optional ?? [])];
    const missing = computeMissing(requires, grant);
    const findings: AuditFinding[] = [];
    if (typeof t.audit === "function") {
      try {
        const result = await Promise.resolve(t.audit());
        if (Array.isArray(result)) findings.push(...result);
      } catch (e) {
        findings.push({
          severity: "error",
          message: `tool.audit() threw: ${(e as Error).message}`,
        });
      }
    }
    // Attribute the tool to its provider, if any. Native tools have
    // no provider attribution.
    let providerKey: string | undefined;
    let providerHandle: string | undefined;
    if (binding.providerInstanceId === "(session)") {
      // Session-contributed tool. Find which layer claimed it by
      // checking each link's contributedTools list, then borrow that
      // layer's source/handle for the attribution. Without this the
      // tool would render as `provider: builtin` even when a provider
      // package's session owns the implementation.
      const layerIdx = perLinkContributions.findIndex((slot) =>
        slot.contributedTools.includes(binding.toolName),
      );
      const layerBinding =
        layerIdx >= 0 ? sessionBindings[layerIdx] : undefined;
      if (layerBinding?.source) {
        providerKey = sourceSpecKey(layerBinding.source);
      }
      if (layerBinding?.providerHandle) {
        providerHandle = layerBinding.providerHandle;
      }
    } else {
      const instance = instanceById.get(binding.providerInstanceId);
      if (instance && instance.kind === "provider" && instance.source) {
        providerKey = sourceSpecKey(instance.source);
      }
      if (instance?.providerHandle) {
        providerHandle = instance.providerHandle;
      }
    }
    tools.push({
      name: binding.toolName,
      requires,
      optional,
      granted: grant,
      missing,
      findings,
      introducedBy: binding.origin,
      subagents,
      ...(providerKey ? { providerKey } : {}),
      ...(providerHandle ? { providerHandle } : {}),
    });
  }

  // Clean up audit-built Tools instances (skip close errors — they're not fatal here).
  await native.close?.();
  for (const p of auditedProviderTools) {
    try {
      await p.close?.();
    } catch {
      /* non-fatal during audit */
    }
  }
  if (auditSession) {
    try {
      await auditSession.close?.();
    } catch {
      /* non-fatal during audit */
    }
  }

  // ─── secrets ────────────────────────────────────────────────────
  const secrets = collectSecrets(manifest, resolved, resolvedTools);

  // ─── session-declared subagents (pre-built instance form only) ──
  // Arrays are SessionSpec[] chains; only the non-array, no-provider
  // shape is a pre-built `Session` instance.
  const sessionSubagents: CapabilityTree[] = [];
  if (
    manifest.session &&
    !Array.isArray(manifest.session) &&
    !("provider" in manifest.session)
  ) {
    const sess = manifest.session as Session;
    for (const sub of sess.dependencies?.subagents ?? []) {
      const subTree = await auditAgentInner(sub, nextSeen);
      sessionSubagents.push(subTree);
      directSubagentTrees.push(subTree);
    }
  }

  // ─── harness / session summaries ────────────────────────
  const harnessSummary = buildHarnessSummary(manifest, resolved);
  const sessionLayerSummaries = buildSessionLayerSummaries(
    manifest,
    resolved,
    perLinkContributions,
    sessionConstructionError,
  );
  const sessionSummary = sessionLayerSummaries?.[0];

  // ─── §1.6: capability-ceiling check ─────────────────────────────
  const capabilityCeilingViolations = checkCapabilityCeiling(
    manifest.name,
    manifestPath,
    effectiveGrants,
    directSubagentTrees,
  );

  return {
    manifestPath,
    name: manifest.name,
    grants: effectiveGrants,
    ...(manifest.secrets !== undefined
      ? { secretAllowlist: manifest.secrets }
      : {}),
    providers,
    harness: harnessSummary,
    ...(sessionSummary ? { session: sessionSummary } : {}),
    ...(sessionLayerSummaries ? { sessionLayers: sessionLayerSummaries } : {}),
    tools,
    secrets,
    sessionSubagents,
    unresolvedTools,
    trustedPaths,
    unresolvedSources,
    capabilityCeilingViolations,
    ...(sessionConstructionError !== undefined
      ? { sessionConstructionError }
      : {}),
  };
}

// ─── factory summaries ───────────────────────────────────────────────────

function buildHarnessSummary(
  manifest: AgentManifest,
  resolved: ReturnType<typeof resolveManifest>,
): FactoryAuditSummary {
  if (!("provider" in manifest.harness)) {
    return {
      display: "<pre-built Harness instance>",
      config: {},
      resolved: true,
      preBuilt: true,
    };
  }
  const binding = resolved.harness;
  if (!binding) {
    // Shouldn't happen — manifest.harness has `kind` but resolver
    // didn't produce a binding. Defensive fallback.
    return {
      display: "<unknown>",
      config: {},
      resolved: false,
      preBuilt: false,
    };
  }
  let registryHit = false;
  try {
    getHarnessFactory(binding.factoryName);
    registryHit = true;
  } catch {
    if (binding.source) {
      try {
        getHarnessFactory(defaultProviderName(binding.source));
        registryHit = true;
      } catch {
        /* still unresolved */
      }
    }
  }
  return {
    display: binding.providerHandle ?? binding.factoryName,
    factoryName: binding.factoryName,
    config: binding.config,
    ...(binding.source ? { providerKey: sourceSpecKey(binding.source) } : {}),
    ...(binding.providerHandle
      ? { providerHandle: binding.providerHandle }
      : {}),
    resolved: registryHit,
    preBuilt: false,
  };
}

/**
 * Build one audit summary per session layer (or a single-element
 * array for a pre-built `Session` instance). Returns undefined when
 * the manifest has no `[session]` block at all — the runtime applies
 * the default chain implicitly, which the audit reflects by omission.
 */
function buildSessionLayerSummaries(
  manifest: AgentManifest,
  resolved: ReturnType<typeof resolveManifest>,
  perLinkContributions: ReadonlyArray<{
    contributedTools: string[];
    trustedPaths: TrustedPath[];
    constructionError?: string;
  }>,
  topLevelConstructionError: string | undefined,
): SessionAuditSummary[] | undefined {
  if (!manifest.session) return undefined;

  // Pre-built `Session` instance — single-link summary.
  if (!Array.isArray(manifest.session) && !("provider" in manifest.session)) {
    return [
      {
        display: "<pre-built Session instance>",
        config: {},
        resolved: true,
        preBuilt: true,
        contributedTools: [],
        trustedPaths: [],
        ...(topLevelConstructionError
          ? { constructionError: topLevelConstructionError }
          : {}),
      },
    ];
  }

  const bindings = resolved.session ?? [];
  if (bindings.length === 0) {
    return [
      {
        display: "<unknown>",
        config: {},
        resolved: false,
        preBuilt: false,
        contributedTools: [],
        trustedPaths: [],
        ...(topLevelConstructionError
          ? { constructionError: topLevelConstructionError }
          : {}),
      },
    ];
  }

  return bindings.map((binding, i) => {
    const slot = perLinkContributions[i] ?? {
      contributedTools: [],
      trustedPaths: [],
    };
    let registryHit = false;
    try {
      getSessionFactory(binding.factoryName);
      registryHit = true;
    } catch {
      if (binding.source) {
        try {
          getSessionFactory(defaultProviderName(binding.source));
          registryHit = true;
        } catch {
          /* unresolved */
        }
      }
    }
    return {
      display: binding.providerHandle ?? binding.factoryName,
      factoryName: binding.factoryName,
      config: binding.config,
      ...(binding.source ? { providerKey: sourceSpecKey(binding.source) } : {}),
      ...(binding.providerHandle
        ? { providerHandle: binding.providerHandle }
        : {}),
      resolved: registryHit,
      preBuilt: false,
      contributedTools: [...slot.contributedTools],
      trustedPaths: [...slot.trustedPaths],
      ...(slot.constructionError
        ? { constructionError: slot.constructionError }
        : {}),
    };
  });
}

// ─── helpers ──────────────────────────────────────────────────────────────

// `defaultProviderName` and `lookupFactoryByBinding` live in
// `runtime/boot.ts` and are imported above (aliased) so the audit and
// the runtime share the same lookup rules.
const defaultProviderName = bootDefaultProviderName;
const lookupFactoryByBinding = bootLookupFactoryByBinding;

function computeMissing(
  requires: string[],
  grant: CapabilitySet | undefined,
): string[] {
  if (grant === "*") return [];
  if (grant === undefined) return [...requires];
  const missing: string[] = [];
  for (const k of requires) {
    if (!Object.prototype.hasOwnProperty.call(grant, k)) missing.push(k);
  }
  return missing;
}

/**
 * §1.6 implementation. For each sub-agent, check that every entry in
 * its `[capabilities]` table is contained by the parent's grant for
 * the same tool key (using `defaultContains` from manifest/capabilities).
 *
 * This is the **static** version of the runtime check that the
 * sub-agent would perform at spawn time. Audit walks ahead of the
 * runtime so authors see the violation before they hit it during
 * a turn.
 */
function checkCapabilityCeiling(
  _parentName: string,
  _parentManifestPath: string,
  parentGrants: Capabilities,
  subagentTrees: CapabilityTree[],
): CapabilityCeilingViolation[] {
  const violations: CapabilityCeilingViolation[] = [];
  for (const sub of subagentTrees) {
    for (const [key, subGrant] of Object.entries(sub.grants)) {
      const parentGrant = parentGrants[key];
      if (!defaultContains(parentGrant, subGrant)) {
        violations.push({
          subagentName: sub.name,
          subagentManifestPath: sub.manifestPath,
          capabilityKey: key,
          subagentGrant: subGrant,
          parentGrant,
        });
      }
    }
  }
  return violations;
}

/**
 * Roll up every secret name the manifest's components declare.
 *
 * Sources:
 *   - harness factory's `secrets` (when reachable from the registry)
 *   - session factory's `secrets`
 *   - every native-resolved tool's `secrets`
 *
 * Provider-contributed Tools-registration secrets aren't included
 * because audit doesn't materialise them per-instance — the audit
 * surface is intentionally conservative.
 */
function collectSecrets(
  manifest: AgentManifest,
  resolved: ReturnType<typeof resolveManifest>,
  tools: Map<string, Tool>,
): SecretRequest[] {
  const required = new Map<string, Set<string>>();
  const optional = new Map<string, Set<string>>();

  const addNeeds = (
    needs: { required?: string[]; optional?: string[] } | undefined,
    by: string,
  ): void => {
    if (!needs) return;
    for (const n of needs.required ?? []) {
      const arr = required.get(n) ?? new Set<string>();
      arr.add(by);
      required.set(n, arr);
    }
    for (const n of needs.optional ?? []) {
      const arr = optional.get(n) ?? new Set<string>();
      arr.add(by);
      optional.set(n, arr);
    }
  };

  // Harness factory needs (skipped when manifest.harness is a pre-built
  // instance — no factory to query for declared secrets).
  if (resolved.harness) {
    try {
      const f = getHarnessFactory(resolved.harness.factoryName);
      addNeeds(f.secrets, `harness:${f.name}`);
    } catch {
      /* unknown harness — skip */
    }
  }
  // Session factory needs (per chain link).
  for (const link of resolved.session ?? []) {
    try {
      const f = lookupFactoryByBinding(
        link.factoryName,
        link.source,
        getSessionFactory,
      );
      addNeeds(f.secrets, `session:${f.name}`);
    } catch {
      /* unknown session — skip */
    }
  }
  // Tool needs.
  for (const [name, tool] of tools) {
    addNeeds(tool.secrets, `tool:${name}`);
  }

  for (const k of required.keys()) optional.delete(k);

  const allowlist = manifest.secrets;
  const isPermitted = (n: string): boolean => {
    if (allowlist === undefined || allowlist === "*") return true;
    return allowlist.includes(n);
  };

  const out: SecretRequest[] = [];
  for (const [name, by] of required) {
    out.push({
      name,
      required: true,
      requestedBy: [...by].sort(),
      permittedByAllowlist: isPermitted(name),
    });
  }
  for (const [name, by] of optional) {
    out.push({
      name,
      required: false,
      requestedBy: [...by].sort(),
      permittedByAllowlist: isPermitted(name),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function stubHarness(): Harness {
  return {
    run: async () => {
      throw new Error(
        "audit: harness.run() called — audit doesn't execute turns",
      );
    },
  };
}

function stubSession(): Session {
  return {
    push: async () => {
      throw new Error("audit: session.push() called");
    },
    pull: async () => [],
  };
}

/** Render options for `formatCapabilityTree`. */
export interface FormatCapabilityTreeOptions {
  /** ANSI colour on/off. Default true. Pass false when piping to a file. */
  color?: boolean;
  /** Internal: starting indent depth for recursive calls. */
  indent?: number;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
} as const;

/** Pretty-print a CapabilityTree. Colours on TTY by default. */
export function formatCapabilityTree(
  tree: CapabilityTree,
  opts: FormatCapabilityTreeOptions = {},
): string {
  const color = opts.color ?? true;
  const indent = opts.indent ?? 0;
  const p = makePainter(color);
  const pad = "  ".repeat(indent);
  const lines: string[] = [];

  // Header.
  lines.push(
    `${pad}${p.bold(p.cyan(tree.name))}  ${p.dim(`(${tree.manifestPath})`)}`,
  );

  // Providers.
  if (tree.providers.length > 0) {
    lines.push(`${pad}  ${p.bold("providers:")}`);
    for (const pl of tree.providers) {
      const label = pl.handle
        ? `${p.cyan(pl.handle)}  ${p.dim(`(${pl.key})`)}`
        : `${p.cyan(pl.key)}  ${p.dim("(inline)")}`;
      const origins =
        pl.origins.length > 0
          ? `  ${p.dim(`referenced by ${pl.origins.join(", ")}`)}`
          : "";
      lines.push(`${pad}    ${p.dim("-")} ${label}${origins}`);
      if (pl.loadError) {
        lines.push(`${pad}      ${p.yellow(`⚠ load failed: ${pl.loadError}`)}`);
      }
    }
  }

  // Harness.
  {
    const h = tree.harness;
    const status = h.resolved
      ? ""
      : `  ${p.yellow("⚠ not registered at audit time")}`;
    lines.push(`${pad}  ${p.bold("harness:")} ${p.cyan(h.display)}${status}`);
    lines.push(`${pad}    ${p.dim("provider:")} ${factoryProviderLabel(h, p)}`);
    const cfgKeys = Object.keys(h.config);
    if (cfgKeys.length > 0) {
      lines.push(
        `${pad}    ${p.dim("config:")} ${p.dim(formatConfig(h.config))}`,
      );
    }
  }

  // Session. Renders the layers as N indented blocks under a single
  // `session:` heading. Singleton sessions (no `layers`) produce the
  // same one-block output as before.
  const layers = tree.sessionLayers ?? (tree.session ? [tree.session] : []);
  if (layers.length > 0) {
    if (layers.length === 1) {
      const s = layers[0]!;
      const status = s.resolved
        ? ""
        : `  ${p.yellow("⚠ not registered at audit time")}`;
      lines.push(`${pad}  ${p.bold("session:")} ${p.cyan(s.display)}${status}`);
      formatSessionLayerBody(s, pad, p, lines, /*layerIndent*/ "    ");
    } else {
      lines.push(
        `${pad}  ${p.bold("session:")} ${p.dim(`${layers.length} layers, outer→inner`)}`,
      );
      for (const [i, s] of layers.entries()) {
        const status = s.resolved
          ? ""
          : `  ${p.yellow("⚠ not registered at audit time")}`;
        lines.push(
          `${pad}    ${p.dim(`[${i}]`)} ${p.cyan(s.display)}${status}`,
        );
        formatSessionLayerBody(s, pad, p, lines, /*layerIndent*/ "      ");
      }
    }
  }

  // Secret allowlist.
  if (tree.secretAllowlist !== undefined) {
    const txt =
      tree.secretAllowlist === "*"
        ? p.dim("* (any name)")
        : tree.secretAllowlist.length === 0
          ? p.dim("[] (no secrets allowed)")
          : `[${tree.secretAllowlist.map((s) => p.cyan(JSON.stringify(s))).join(", ")}]`;
    lines.push(`${pad}  ${p.bold("[agent].secrets allowlist:")} ${txt}`);
  }

  // Tools.
  if (tree.tools.length > 0) {
    lines.push(`${pad}  ${p.bold("tools:")}`);
    for (const t of tree.tools) {
      const reqStr =
        t.requires.length > 0
          ? ` requires ${t.requires.map((r) => p.green(`'${r}'`)).join(", ")}`
          : "";
      const optStr =
        t.optional.length > 0
          ? ` ${p.dim("optional")} ${t.optional.map((r) => p.dim(`'${r}'`)).join(", ")}`
          : "";
      const missingStr =
        t.missing.length > 0
          ? `  ${p.yellow("⚠ MISSING:")} ${p.yellow(t.missing.join(", "))}`
          : "";
      lines.push(
        `${pad}    ${p.dim("-")} ${p.bold(p.yellow(t.name))} ${p.dim(`(from ${t.introducedBy})`)}:${reqStr}${optStr}${missingStr}`,
      );
      lines.push(
        `${pad}      ${p.dim("provider:")} ${toolProviderLabel(t, p)}`,
      );
      lines.push(
        `${pad}      ${p.dim("granted:")} ${p.dim(formatGrant(t.granted))}`,
      );
      for (const f of t.findings) {
        const { icon, paint } = severityIcon(f.severity, p);
        lines.push(`${pad}      ${paint(icon)} ${f.message}`);
        if (f.remediation) {
          lines.push(`${pad}        ${p.dim(`→ ${f.remediation}`)}`);
        }
      }
      for (const sub of t.subagents) {
        lines.push(`${pad}      ${p.dim("sub-agent:")}`);
        lines.push(formatCapabilityTree(sub, { color, indent: indent + 4 }));
      }
    }
  }

  // Grants.
  const grantKeys = Object.keys(tree.grants);
  if (grantKeys.length > 0) {
    lines.push(`${pad}  ${p.bold("capabilities granted:")}`);
    for (const [k, v] of Object.entries(tree.grants)) {
      lines.push(
        `${pad}    ${p.dim("-")} ${p.green(k)}: ${p.dim(formatGrant(v))}`,
      );
    }
  } else {
    lines.push(`${pad}  ${p.bold("capabilities granted:")} ${p.dim("(none)")}`);
  }

  // Unresolved sources.
  if (tree.unresolvedSources.length > 0) {
    lines.push(
      `${pad}  ${p.bold(p.yellow("unresolved sources"))} ${p.dim("(run `loom install` to materialise):")}`,
    );
    for (const u of tree.unresolvedSources) {
      lines.push(`${pad}    ${p.dim("-")} ${p.yellow(u.spec)}`);
      lines.push(`${pad}      ${p.dim(`↳ ${u.reason}`)}`);
    }
  }

  // Unresolved tools.
  if (tree.unresolvedTools.length > 0) {
    lines.push(`${pad}  ${p.bold(p.yellow("unresolved tools:"))}`);
    for (const u of tree.unresolvedTools) {
      lines.push(
        `${pad}    ${p.dim("-")} ${p.yellow(u.name)} ${p.dim(`(from ${u.introducedBy})`)}`,
      );
    }
  }

  // Capability-ceiling violations.
  if (tree.capabilityCeilingViolations.length > 0) {
    lines.push(
      `${pad}  ${p.bold(p.red("capability-ceiling violations"))} ${p.dim("(subagent exceeds parent grant):")}`,
    );
    for (const v of tree.capabilityCeilingViolations) {
      lines.push(
        `${pad}    ${p.dim("-")} ${p.red(v.subagentName)} ${p.dim(`(${v.subagentManifestPath})`)}: '${p.yellow(v.capabilityKey)}'`,
      );
      lines.push(
        `${pad}      ${p.dim("subagent wants:")} ${formatGrant(v.subagentGrant)}`,
      );
      lines.push(
        `${pad}      ${p.dim("parent grants:")} ${formatGrant(v.parentGrant)}`,
      );
    }
  }

  // Note: trusted paths and session construction errors are rendered
  // under the `session:` section above. They're also kept at the top
  // level of CapabilityTree for back-compat.

  // Session sub-agents.
  if (tree.sessionSubagents.length > 0) {
    lines.push(`${pad}  ${p.bold("session sub-agents:")}`);
    for (const sub of tree.sessionSubagents) {
      lines.push(formatCapabilityTree(sub, { color, indent: indent + 2 }));
    }
  }

  // Secrets.
  if (tree.secrets.length > 0) {
    lines.push(`${pad}  ${p.bold("secrets:")}`);
    for (const s of tree.secrets) {
      const tag = s.required ? p.yellow("[required]") : p.dim("[optional]");
      const block = s.permittedByAllowlist
        ? ""
        : `  ${p.red("⚠ DENIED by [agent].secrets")}`;
      lines.push(
        `${pad}    ${p.dim("-")} ${p.cyan(s.name)} ${tag} ${p.dim(`(needed by ${s.requestedBy.join(", ")})`)}${block}`,
      );
    }
  }

  return lines.join("\n");
}

/** Print one session layer's body (everything under its heading). */
function formatSessionLayerBody(
  s: SessionAuditSummary,
  pad: string,
  p: ReturnType<typeof makePainter>,
  lines: string[],
  layerIndent: string,
): void {
  lines.push(
    `${pad}${layerIndent}${p.dim("provider:")} ${factoryProviderLabel(s, p)}`,
  );
  const cfgKeys = Object.keys(s.config);
  if (cfgKeys.length > 0) {
    lines.push(
      `${pad}${layerIndent}${p.dim("config:")} ${p.dim(formatConfig(s.config))}`,
    );
  }
  if (s.contributedTools.length > 0) {
    lines.push(
      `${pad}${layerIndent}${p.dim("contributes tools:")} ${s.contributedTools
        .map((t) => p.yellow(t))
        .join(", ")}`,
    );
  }
  if (s.trustedPaths.length > 0) {
    lines.push(`${pad}${layerIndent}${p.dim("trusted paths:")}`);
    for (const tp of s.trustedPaths) {
      const reason = tp.reason ? p.dim(` — ${tp.reason}`) : "";
      lines.push(
        `${pad}${layerIndent}  ${p.dim("-")} ${tp.path} ${p.magenta(`[${tp.access}]`)}${reason}`,
      );
    }
  }
  if (s.constructionError) {
    lines.push(
      `${pad}${layerIndent}${p.yellow(`⚠ construction error: ${s.constructionError}`)}`,
    );
  }
}

function formatGrant(v: CapabilitySet | undefined): string {
  if (v === undefined) return "(none)";
  if (v === "*") return "*";
  return JSON.stringify(v);
}

function formatConfig(cfg: Record<string, unknown>): string {
  return JSON.stringify(cfg);
}

/**
 * Label for the `provider:` line under harness/session entries:
 *   - `"builtin"` for built-in factories
 *   - `"<pre-built instance>"` for SDK-supplied instances
 *   - `"<handle> (<key>)"` when both are known
 *   - `"<handle>"` or `"<key>"` when only one is
 */
function factoryProviderLabel(
  summary: FactoryAuditSummary,
  p: ReturnType<typeof makePainter>,
): string {
  if (summary.preBuilt) return p.dim("<pre-built instance>");
  if (summary.providerHandle && summary.providerKey) {
    return `${p.cyan(summary.providerHandle)}  ${p.dim(`(${summary.providerKey})`)}`;
  }
  if (summary.providerHandle) return p.cyan(summary.providerHandle);
  if (summary.providerKey) return p.cyan(summary.providerKey);
  return p.dim("builtin");
}

/**
 * Label for the `provider:` line under each tool entry. Same shape as
 * `factoryProviderLabel`, but tools never carry a pre-built instance.
 */
function toolProviderLabel(
  t: CapabilityTree["tools"][number],
  p: ReturnType<typeof makePainter>,
): string {
  if (t.providerHandle && t.providerKey) {
    return `${p.cyan(t.providerHandle)}  ${p.dim(`(${t.providerKey})`)}`;
  }
  if (t.providerHandle) return p.cyan(t.providerHandle);
  if (t.providerKey) return p.cyan(t.providerKey);
  return p.dim("builtin");
}

function makePainter(color: boolean) {
  const wrap = (code: string) => (s: string) =>
    color ? `${code}${s}${ANSI.reset}` : s;
  return {
    bold: wrap(ANSI.bold),
    dim: wrap(ANSI.dim),
    cyan: wrap(ANSI.cyan),
    yellow: wrap(ANSI.yellow),
    green: wrap(ANSI.green),
    red: wrap(ANSI.red),
    magenta: wrap(ANSI.magenta),
  };
}

function severityIcon(
  sev: AuditSeverity,
  p: ReturnType<typeof makePainter>,
): { icon: string; paint: (s: string) => string } {
  if (sev === "ok") return { icon: "✓", paint: p.green };
  if (sev === "warning") return { icon: "⚠", paint: p.yellow };
  return { icon: "✗", paint: p.red };
}

// Re-export the ResolvedSource type for consumers that read trees.
export type { ResolvedSource };
