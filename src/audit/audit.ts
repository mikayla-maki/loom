import * as path from "node:path";

import {
  isPreBuiltSessionLayer,
  resolveManifest,
  resolveSystemPrompt,
  sourceSpecKey,
  type ResolvedSessionLayer,
  type ResolvedSource,
} from "../manifest/resolver.js";
import {
  findToolsFactory,
  getHarnessFactory,
  getSessionFactory,
} from "../builtins/index.js";
import {
  buildNativeTools,
  nativeBuiltinNames,
} from "../builtins/tools/native.js";
import { DEFAULT_CLIENT_ACP_CAPABILITIES } from "../runtime/acp-capabilities.js";
import {
  instantiateFromBinding,
  loadManifestProviders,
  lookupFactoryByBinding as bootLookupFactoryByBinding,
  materialiseTools as bootMaterialiseTools,
  defaultProviderName as bootDefaultProviderName,
  type ToolsIndex,
} from "../runtime/boot.js";
import {
  buildSecretStore,
  collectPhase1SecretNeeds,
  describeSecretStores,
  loadSecretsBundle,
} from "../sdk/run-agent.js";
import { resolveAgentStorage } from "../runtime/storage.js";
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
  permittedByAllowlist: boolean;
  /**
   * Label of the store the secret resolved from (e.g. `"environment"`,
   * `".loom-secrets (manifest dir)"`), or undefined when no store had it.
   * See `describeSecretStores`.
   */
  resolvedFrom?: string;
}

export interface ProviderSummary {
  /** Canonical structural key (matches `lock.toml`). */
  key: string;
  source?: SourceSpec;
  /** Local `[providers]` handle, when declared. */
  handle?: string;
  /** Factory name for `[providers]` configured-factory entries (e.g. `"mcp-server"`). */
  factoryName?: string;
  origins: string[];
  loadError?: string;
  /** init() threw — distinct from `loadError` (package loaded, but spawn/handshake failed). */
  initError?: string;
  mcpServer?: {
    name: string;
    version: string;
    protocolVersion: string;
    advertisedButUnexposed: string[];
  };
}

export interface FactoryAuditSummary {
  display: string;
  factoryName?: string;
  config: Record<string, unknown>;
  providerKey?: string;
  providerHandle?: string;
  resolved: boolean;
  preBuilt: boolean;
  /** Tool names the harness can expose via `availableTools()`. Harness summaries only. */
  availableTools?: string[];
}

export interface SessionAuditSummary extends FactoryAuditSummary {
  contributedTools: string[];
  trustedPaths: TrustedPath[];
  constructionError?: string;
}

export interface CapabilityCeilingViolation {
  subagentName: string;
  subagentManifestPath: string;
  capabilityKey: string;
  subagentGrant: CapabilitySet;
  parentGrant: CapabilitySet | undefined;
}

export interface CapabilityTree {
  manifestPath: string;
  name: string;
  grants: Capabilities;
  secretAllowlist?: SecretAllowlist;
  storage: {
    path: string;
    source: "storage_id" | "name";
    warnings: string[];
  };
  providers: ProviderSummary[];
  tools: Array<{
    name: string;
    requires: string[];
    optional: string[];
    granted: CapabilitySet | undefined;
    missing: string[];
    findings: AuditFinding[];
    introducedBy: string;
    subagents: CapabilityTree[];
    providerKey?: string;
    providerHandle?: string;
    /** Model-visible JSON Schema (post-narrowing for argument-bound tools). */
    inputSchema?: unknown;
    boundArgs?: string[];
  }>;
  secrets: SecretRequest[];
  sessionSubagents: CapabilityTree[];
  unresolvedTools: Array<{ name: string; introducedBy: string }>;
  harness: FactoryAuditSummary;
  /** Outermost session layer; see {@link sessionLayers} for all layers. */
  session?: SessionAuditSummary;
  /** Every session layer, outer-to-inner. Present whenever {@link session} is. */
  sessionLayers?: SessionAuditSummary[];
  /** @deprecated Read `session.trustedPaths` instead. */
  trustedPaths: TrustedPath[];
  /** @deprecated Read `session.constructionError` instead. */
  sessionConstructionError?: string;
  unresolvedSources: Array<{
    spec: string;
    source: SourceSpec;
    reason: string;
  }>;
  capabilityCeilingViolations: CapabilityCeilingViolation[];
}

export type AuditOptions = Record<string, never>;

const DEFAULT_TOP_LEVEL_CAPABILITIES: Capabilities = {
  bash: { commands: "*", paths: ["./"] },
  read_file: { paths: ["./"] },
  write_file: { paths: ["./"] },
  edit_file: { paths: ["./"] },
};

/**
 * Run a static audit against a manifest. Returns a `CapabilityTree`
 * when the manifest fully resolves, or throws `AuditError` with the
 * partial tree + structured problem list attached. Callers wanting
 * a partially-resolved tree should catch `AuditError` and read
 * `error.tree` + `error.health`.
 */
export async function auditAgent(
  source: string | AgentManifest,
  _options: AuditOptions = {},
): Promise<CapabilityTree> {
  void _options;
  const tree = await auditAgentInner(source, new Set());
  const health = summariseAuditHealth(tree);
  if (health.totalProblems > 0) {
    throw new AuditError(formatAuditFailure(tree.name, health), tree, health);
  }
  return tree;
}

/** Thrown by `auditAgent()` when a manifest doesn't fully resolve. */
export class AuditError extends LoomError {
  constructor(
    message: string,
    public readonly tree: CapabilityTree,
    public readonly health: AuditHealth,
  ) {
    super(message);
  }
}

/**
 * Audit-health summary, recursive over the agent tree. `totalProblems`
 * rolls up through every reachable sub-agent; per-node counts give
 * direct attribution; `subagents` walks the recursive structure.
 */
export interface AuditHealth {
  agentName: string;
  /** This node's problems plus every sub-agent's. Audit succeeds iff zero. */
  totalProblems: number;
  /** This node's direct problems, sum of the per-category counts below. */
  directProblems: number;
  unresolvedSources: number;
  /** Providers that loaded but failed to construct or initialise. */
  providerInitErrors: number;
  /** Tools named in `[tools]` that no provider claimed at audit time. */
  unresolvedTools: number;
  /** Tools whose `requires` capability kinds aren't granted by `[capabilities]`. */
  toolsMissingRequires: number;
  capabilityCeilingViolations: number;
  /** Tool `audit()` findings with severity `"error"`. */
  toolAuditErrors: number;
  subagents: AuditHealth[];
}

export function summariseAuditHealth(tree: CapabilityTree): AuditHealth {
  const unresolvedSources = tree.unresolvedSources.length;
  const providerInitErrors = tree.providers.filter(
    (p) => p.initError && !p.loadError,
  ).length;
  const unresolvedTools = tree.unresolvedTools.filter(
    (u) => u.name !== "(cycle)",
  ).length;
  const toolsMissingRequires = tree.tools.filter(
    (t) => t.missing.length > 0,
  ).length;
  const capabilityCeilingViolations = tree.capabilityCeilingViolations.length;
  let toolAuditErrors = 0;
  for (const t of tree.tools) {
    for (const f of t.findings) {
      if (f.severity === "error") toolAuditErrors++;
    }
  }
  const directProblems =
    unresolvedSources +
    providerInitErrors +
    unresolvedTools +
    toolsMissingRequires +
    capabilityCeilingViolations +
    toolAuditErrors;

  const subagentTrees: CapabilityTree[] = [
    ...tree.tools.flatMap((t) => t.subagents),
    ...tree.sessionSubagents,
  ];
  const subagents = subagentTrees.map(summariseAuditHealth);
  const subagentTotal = subagents.reduce((sum, s) => sum + s.totalProblems, 0);

  return {
    agentName: tree.name,
    totalProblems: directProblems + subagentTotal,
    directProblems,
    unresolvedSources,
    providerInitErrors,
    unresolvedTools,
    toolsMissingRequires,
    capabilityCeilingViolations,
    toolAuditErrors,
    subagents,
  };
}

function formatAuditFailure(name: string, h: AuditHealth): string {
  const affectedAgents = countAffectedAgents(h);
  const headerSuffix =
    affectedAgents > 1 ? ` across ${affectedAgents} agent(s)` : "";
  const lines: string[] = [
    `'${name}' is not fully resolved (${h.totalProblems} problem(s)${headerSuffix}):`,
  ];
  appendHealthLines(h, [], lines);
  return lines.join("\n");
}

function appendHealthLines(
  h: AuditHealth,
  path: string[],
  out: string[],
): void {
  if (h.directProblems > 0) {
    const label =
      path.length === 0 ? h.agentName : path.concat(h.agentName).join(" → ");
    out.push(`  ${label}:`);
    if (h.unresolvedSources > 0) {
      out.push(
        `    - ${h.unresolvedSources} unresolved source(s) — run \`loom install\``,
      );
    }
    if (h.providerInitErrors > 0) {
      out.push(
        `    - ${h.providerInitErrors} provider load/init failure(s) — see provider summary for details`,
      );
    }
    if (h.unresolvedTools > 0) {
      out.push(
        `    - ${h.unresolvedTools} unresolved [tools] entr(ies) — no provider claimed the name`,
      );
    }
    if (h.toolsMissingRequires > 0) {
      out.push(
        `    - ${h.toolsMissingRequires} tool(s) missing required capability grants`,
      );
    }
    if (h.capabilityCeilingViolations > 0) {
      out.push(
        `    - ${h.capabilityCeilingViolations} sub-agent capability-ceiling violation(s)`,
      );
    }
    if (h.toolAuditErrors > 0) {
      out.push(
        `    - ${h.toolAuditErrors} tool.audit() error finding(s) — tools that would fail at runtime`,
      );
    }
  }
  for (const sub of h.subagents) {
    appendHealthLines(sub, path.concat(h.agentName), out);
  }
}

function countAffectedAgents(h: AuditHealth): number {
  let n = h.directProblems > 0 ? 1 : 0;
  for (const sub of h.subagents) n += countAffectedAgents(sub);
  return n;
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

  const cycleKey = manifest.manifestPath ?? `<inline:${manifest.name}>`;
  if (seenManifests.has(cycleKey)) {
    return {
      manifestPath,
      name: manifest.name,
      grants: {},
      storage: { path: "", source: "name", warnings: [] },
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
  void (await resolveSystemPrompt(manifest, baseDir));

  const builtinToolNames = new Set(nativeBuiltinNames());
  const resolved = resolveManifest(manifest, { builtinToolNames });

  // Provider load failures are collected (not thrown like the runtime
  // does) so audit can keep walking the tree.
  const storage = await resolveAgentStorage(manifest);
  const factoryCtx: FactoryContext = {
    manifestDir: baseDir,
    agentName: manifest.name,
    loomVersion: "audit",
    clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
    storage: storage.path,
    metadata: manifest.metadata ?? {},
  };
  const { toolsIndex, loadErrors } = await loadManifestProviders(
    resolved,
    factoryCtx,
  );

  // Best-effort secrets so provider Tools whose `create()` consults
  // them (e.g. MCP) can construct. Missing secrets stay absent rather
  // than failing audit.
  let auditSecrets: Record<string, string> = {};
  try {
    const store = buildSecretStore(manifest, {});
    auditSecrets = await loadSecretsBundle(
      store,
      collectPhase1SecretNeeds(resolved, toolsIndex),
      /*allowMissingRequired*/ true,
      undefined,
    );
  } catch {
    /* fall through with empty secrets */
  }

  const unresolvedSources: CapabilityTree["unresolvedSources"] = [];
  const providers: ProviderSummary[] = [];
  const providerSummariesByInstanceId = new Map<string, ProviderSummary>();
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
    for (const p of resolved.providers) {
      if (
        p.kind === "provider" &&
        p.source &&
        sourceSpecKey(p.source) === key
      ) {
        providerSummariesByInstanceId.set(p.id, summary);
      }
    }
  }
  // Configured-factory `[providers]` entries have no SourceSpec, so
  // add a synthetic summary per factory-backed instance.
  for (const p of resolved.providers) {
    if (p.kind !== "provider" || p.source || !p.factoryName) continue;
    const summary: ProviderSummary = {
      key: `factory:${p.factoryName}#${p.id}`,
      factoryName: p.factoryName,
      ...(p.providerHandle ? { handle: p.providerHandle } : {}),
      origins: [originLabelFor(p)],
    };
    providers.push(summary);
    providerSummariesByInstanceId.set(p.id, summary);
  }
  // Declared handles first (alphabetically), then inline.
  providers.sort((a, b) => {
    if (a.handle && !b.handle) return -1;
    if (!a.handle && b.handle) return 1;
    return (a.handle ?? a.key).localeCompare(b.handle ?? b.key);
  });

  // Instantiate every chain link individually so contributed tools
  // and trusted paths can be attributed to the link that produced
  // them, then compose via ChainedSession when there's more than one.
  const trustedPaths: TrustedPath[] = [];
  let auditSession: Session | null = null;
  let sessionConstructionError: string | undefined;
  const sessionBindings = resolved.session ?? [];
  const perLinkContributions: Array<{
    contributedTools: string[];
    trustedPaths: TrustedPath[];
    constructionError?: string;
  }> = [];
  const auditedSessionLinks: Session[] = [];
  for (const [i, layer] of sessionBindings.entries()) {
    let linkInstance: Session | null = null;
    let linkError: string | undefined;
    if (isPreBuiltSessionLayer(layer)) {
      linkInstance = layer.instance;
      auditedSessionLinks.push(layer.instance);
    } else {
      try {
        const { instance } = await instantiateFromBinding<Session>(
          layer,
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
            : `session link ${i} ('${layer.factoryName}')`;
        sessionConstructionError =
          (sessionConstructionError ? sessionConstructionError + "; " : "") +
          `${linkLabel}: ${linkError}`;
      }
    }
    perLinkContributions.push({
      contributedTools: [],
      trustedPaths: [],
      ...(linkError ? { constructionError: linkError } : {}),
    });
    void linkInstance;
  }
  if (auditedSessionLinks.length === 1) {
    const [only] = auditedSessionLinks as [Session];
    auditSession = only;
  } else if (auditedSessionLinks.length > 1) {
    auditSession = new ChainedSession(auditedSessionLinks);
  }

  const sessionToolBindings: typeof resolved.tools = [];
  const claimedSessionTools = new Set(resolved.tools.map((b) => b.toolName));
  let cursor = 0;
  for (const [i, layer] of sessionBindings.entries()) {
    const slot = perLinkContributions[i];
    if (!slot) {
      throw new Error(
        `audit: perLinkContributions missing slot for layer ${i}`,
      );
    }
    if (slot.constructionError) continue;
    const linkInstance = auditedSessionLinks[cursor++];
    if (!linkInstance) {
      throw new Error(`audit: auditedSessionLinks exhausted before layer ${i}`);
    }
    const layerLabel = sessionLayerLabel(layer);
    const originLabel =
      sessionBindings.length === 1
        ? `(session: ${layerLabel})`
        : `(session link ${i}: ${layerLabel})`;
    try {
      const refs = (await linkInstance.tools?.()) ?? [];
      for (const ref of refs) {
        slot.contributedTools.push(ref.name);
        if (claimedSessionTools.has(ref.name)) continue;
        claimedSessionTools.add(ref.name);
        sessionToolBindings.push({
          toolName: ref.name,
          providerInstanceId: "(session)",
          toolConfig: typeof ref.config === "string" ? {} : ref.config,
          origin: originLabel,
        });
      }
    } catch (e) {
      sessionConstructionError =
        (sessionConstructionError ? sessionConstructionError + "; " : "") +
        `session link ${i} ('${layerLabel}') .tools() threw: ${
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
        `session link ${i} ('${layerLabel}') .trustedPaths() threw: ${
          (e as Error).message
        }`;
    }
  }

  const effectiveGrants: Capabilities =
    manifest.tools === undefined && manifest.capabilities === undefined
      ? DEFAULT_TOP_LEVEL_CAPABILITIES
      : (manifest.capabilities ?? {});

  const native = buildNativeTools();
  const auditAgentRef: Agent = {
    manifest,
    harness: stubHarness(),
    session: stubSession(),
    systemPromptCore: "",
  };

  const providerByInstanceId = new Map<string, Tools>();
  const auditedProviderTools: Tools[] = [];
  for (const p of resolved.providers) {
    if (p.kind === "native") {
      providerByInstanceId.set(p.id, native);
      continue;
    }
    const summary = providerSummariesByInstanceId.get(p.id);
    let tools: Tools;
    try {
      ({ tools } = await bootMaterialiseTools(
        p,
        toolsIndex,
        factoryCtx,
        auditSecrets,
        undefined,
      ));
    } catch (e) {
      if (summary) {
        summary.initError = (e as Error).message;
      }
      continue;
    }
    providerByInstanceId.set(p.id, tools);
    auditedProviderTools.push(tools);
    // Best-effort init() so MCP server info + tool cache populate
    // before we walk tool bindings.
    if (tools.init) {
      try {
        await tools.init({
          manifest,
          config: p.config,
          secrets: auditSecrets,
          factoryContext: factoryCtx,
          runtime: {
            async requestPermission() {
              throw new Error("audit doesn't route runtime requests");
            },
          },
        });
      } catch (e) {
        if (summary) {
          summary.initError = (e as Error).message;
        }
        continue;
      }
    }
    if (summary) attachMcpServerInfo(summary, tools, resolved, p.id);
  }

  // Mirror the runtime's synthetic `"(session)"` Tools instance.
  // Sessions with `resolveTool` own the tools they advertise; the
  // skills pattern falls through to native below.
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

  // Mirror the runtime's synthetic `"(harness)"` Tools instance,
  // constructing the harness best-effort so harness-routed tool
  // bindings resolve. Required secrets the audit couldn't fetch are
  // stubbed so construction succeeds — audit never calls the API.
  let auditHarness: Harness | undefined;
  let auditHarnessAvailableTools: string[] = [];
  if (resolved.harness) {
    try {
      const harnessFactory = lookupFactoryByBinding(
        resolved.harness.factoryName,
        resolved.harness.source,
        getHarnessFactory,
      );
      const harnessSecrets = { ...auditSecrets };
      for (const name of harnessFactory.secrets?.required ?? []) {
        if (harnessSecrets[name] === undefined) {
          harnessSecrets[name] = "audit-mode-stub";
        }
      }
      const { instance } = await instantiateFromBinding<Harness>(
        resolved.harness,
        getHarnessFactory,
        factoryCtx,
        harnessSecrets,
        undefined,
        "harness",
      );
      auditHarness = instance;
      try {
        const catalog = (await instance.availableTools?.()) ?? [];
        auditHarnessAvailableTools = catalog.map((r) => r.name);
      } catch {
        /* harness availableTools threw — leave empty */
      }
    } catch {
      /* harness construction failed — tools route as unresolved */
    }
  } else if (!("provider" in manifest.harness)) {
    auditHarness = manifest.harness as Harness;
    try {
      const catalog = (await auditHarness.availableTools?.()) ?? [];
      auditHarnessAvailableTools = catalog.map((r) => r.name);
    } catch {
      /* ignore */
    }
  }
  if (auditHarness) {
    const h = auditHarness;
    providerByInstanceId.set("(harness)", {
      async resolveTool(name, config, agent, capabilities) {
        if (!h.resolveTool) return null;
        return Promise.resolve(
          h.resolveTool(name, config, agent, capabilities),
        );
      },
    });
  }

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
      t = null;
    }
    // Mirror the runtime's `"(session)"` → native fallback.
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
    let providerKey: string | undefined;
    let providerHandle: string | undefined;
    if (binding.providerInstanceId === "(session)") {
      const layerIdx = perLinkContributions.findIndex((slot) =>
        slot.contributedTools.includes(binding.toolName),
      );
      const layerBinding =
        layerIdx >= 0 ? sessionBindings[layerIdx] : undefined;
      const layerLabel = layerBinding
        ? sessionLayerLabel(layerBinding)
        : undefined;
      if (layerBinding && !isPreBuiltSessionLayer(layerBinding)) {
        if (layerBinding.source) {
          providerKey = sourceSpecKey(layerBinding.source);
        }
      }
      providerHandle = layerLabel
        ? `session:${layerLabel}`
        : "session:<unknown>";
    } else if (binding.providerInstanceId === "(harness)") {
      if (resolved.harness?.factoryName) {
        providerHandle = `harness:${resolved.harness.factoryName}`;
      } else if (!("provider" in manifest.harness)) {
        providerHandle = "harness:<pre-built>";
      }
    } else {
      const instance = instanceById.get(binding.providerInstanceId);
      if (instance && instance.kind === "provider" && instance.source) {
        providerKey = sourceSpecKey(instance.source);
      }
      if (
        instance &&
        instance.kind === "provider" &&
        !instance.source &&
        instance.factoryName
      ) {
        providerKey = `factory:${instance.factoryName}#${instance.id}`;
      }
      if (instance?.providerHandle) {
        providerHandle = instance.providerHandle;
      }
    }
    const boundArgs = boundArgsForGrant(grant);
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
      ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
      ...(boundArgs.length > 0 ? { boundArgs } : {}),
    });
  }

  // Compute the "advertised but unexposed" set per factory-backed
  // provider — tools the MCP server offered that the manifest didn't
  // opt into.
  for (const [instanceId, summary] of providerSummariesByInstanceId) {
    if (!summary.mcpServer) continue;
    const exposed = new Set<string>();
    for (const binding of resolved.tools) {
      if (binding.providerInstanceId !== instanceId) continue;
      const dispatched =
        typeof binding.toolConfig.tool === "string"
          ? (binding.toolConfig.tool as string)
          : binding.toolName;
      exposed.add(dispatched);
    }
    const tools = providerByInstanceId.get(instanceId);
    const cache = (tools as unknown as { toolsCache?: Map<string, unknown> })
      ?.toolsCache;
    if (!cache) continue;
    summary.mcpServer.advertisedButUnexposed = [...cache.keys()]
      .filter((n) => !exposed.has(n))
      .sort();
  }

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

  const secrets = collectSecrets(manifest, resolved, resolvedTools, toolsIndex);

  // Annotate each secret with where it would resolve from, walking the same
  // store tiers the runtime uses (highest priority first). Best-effort: a
  // misconfigured store never aborts the audit.
  const secretTiers = describeSecretStores(manifest, {});
  for (const secret of secrets) {
    for (const tier of secretTiers) {
      let value: string | null = null;
      try {
        value = await tier.store.get(secret.name);
      } catch {
        continue;
      }
      if (value !== null && value.length > 0) {
        secret.resolvedFrom = tier.label;
        break;
      }
    }
  }

  // Session-declared subagents (pre-built instance form only): arrays
  // are SessionSpec[] chains; only the non-array, no-provider shape is
  // a pre-built `Session` instance.
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

  const harnessSummary = buildHarnessSummary(
    manifest,
    resolved,
    auditHarnessAvailableTools,
  );
  const sessionLayerSummaries = buildSessionLayerSummaries(
    manifest,
    resolved,
    perLinkContributions,
    sessionConstructionError,
  );
  const sessionSummary = sessionLayerSummaries?.[0];

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
    storage: {
      path: storage.path,
      source: storage.source,
      // Collision warnings only on the top-level audit; sub-agents
      // inherit identity from a parent that already reported them.
      warnings: seenManifests.size === 0 ? storage.warnings : [],
    },
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

function buildHarnessSummary(
  manifest: AgentManifest,
  resolved: ReturnType<typeof resolveManifest>,
  availableTools: string[],
): FactoryAuditSummary {
  const availOpt =
    availableTools.length > 0 ? { availableTools: [...availableTools] } : {};
  if (!("provider" in manifest.harness)) {
    return {
      display: "<pre-built Harness instance>",
      config: {},
      resolved: true,
      preBuilt: true,
      ...availOpt,
    };
  }
  const binding = resolved.harness;
  if (!binding) {
    return {
      display: "<unknown>",
      config: {},
      resolved: false,
      preBuilt: false,
      ...availOpt,
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
    ...availOpt,
  };
}

/**
 * One audit summary per session layer. Returns undefined when the
 * manifest has no `[session]` block (the runtime applies the default
 * chain implicitly, reflected here by omission).
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

  return bindings.map((layer, i) => {
    const slot = perLinkContributions[i] ?? {
      contributedTools: [],
      trustedPaths: [],
    };
    if (isPreBuiltSessionLayer(layer)) {
      return {
        display: "<pre-built Session instance>",
        config: {},
        resolved: true,
        preBuilt: true,
        contributedTools: [...slot.contributedTools],
        trustedPaths: [...slot.trustedPaths],
        ...(slot.constructionError
          ? { constructionError: slot.constructionError }
          : {}),
      };
    }
    let registryHit = false;
    try {
      getSessionFactory(layer.factoryName);
      registryHit = true;
    } catch {
      if (layer.source) {
        try {
          getSessionFactory(defaultProviderName(layer.source));
          registryHit = true;
        } catch {
          /* unresolved */
        }
      }
    }
    return {
      display: layer.providerHandle ?? layer.factoryName,
      factoryName: layer.factoryName,
      config: layer.config,
      ...(layer.source ? { providerKey: sourceSpecKey(layer.source) } : {}),
      ...(layer.providerHandle ? { providerHandle: layer.providerHandle } : {}),
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

/** Human-readable identifier for a `ResolvedSessionLayer`. */
function sessionLayerLabel(layer: ResolvedSessionLayer): string {
  return isPreBuiltSessionLayer(layer)
    ? "(pre-built)"
    : (layer.providerHandle ?? layer.factoryName);
}

// Aliased re-exports of boot helpers so audit and runtime share the
// same factory lookup rules.
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
    if (!Object.hasOwn(grant, k)) missing.push(k);
  }
  return missing;
}

/**
 * Static version of the runtime spawn-time check: each sub-agent's
 * `[capabilities]` entries must be contained by the parent's grant for
 * the same tool key. See §1.6 of the manifest spec.
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
 * Roll up every secret name the manifest's components declare —
 * harness, session, tools, and provider-Tools contributions (both
 * static `secrets` and per-instance `instanceSecretNeeds(config)`).
 * Mirrors the runtime's `collectPhase1SecretNeeds`.
 */
function collectSecrets(
  manifest: AgentManifest,
  resolved: ReturnType<typeof resolveManifest>,
  tools: Map<string, Tool>,
  toolsIndex: ToolsIndex,
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

  if (resolved.harness) {
    try {
      const f = getHarnessFactory(resolved.harness.factoryName);
      addNeeds(f.secrets, `harness:${f.name}`);
    } catch {
      /* unknown harness — skip */
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
      addNeeds(f.secrets, `session:${f.name}`);
    } catch {
      /* unknown session — skip */
    }
  }
  for (const [name, tool] of tools) {
    addNeeds(tool.secrets, `tool:${name}`);
  }

  for (const instance of resolved.providers) {
    if (instance.kind !== "provider") continue;
    let contribution:
      | {
          name: string;
          secrets?: { required?: string[]; optional?: string[] };
          instanceSecretNeeds?(
            config: Record<string, unknown>,
          ): { required?: string[]; optional?: string[] } | undefined;
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
    const label = instance.providerHandle
      ? `provider:${instance.providerHandle}`
      : `provider:${contribution.name}`;
    addNeeds(contribution.secrets, label);
    if (contribution.instanceSecretNeeds) {
      addNeeds(contribution.instanceSecretNeeds(instance.config), label);
    }
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

function originLabelFor(
  p: ReturnType<typeof resolveManifest>["providers"][number],
): string {
  if (p.origin.kind === "handle-factory") {
    return `(via [providers].${p.origin.providerHandle} → factory '${p.origin.factoryName}')`;
  }
  return "(factory-backed)";
}

/** Duck-typed: attach MCP `serverInfo` to the summary when present. */
function attachMcpServerInfo(
  summary: ProviderSummary,
  tools: Tools,
  _resolved: ReturnType<typeof resolveManifest>,
  _instanceId: string,
): void {
  const info = (
    tools as unknown as {
      serverInfo?: {
        name: string;
        version: string;
        protocolVersion: string;
      };
    }
  ).serverInfo;
  if (!info) return;
  summary.mcpServer = {
    name: info.name,
    version: info.version,
    protocolVersion: info.protocolVersion,
    advertisedButUnexposed: [],
  };
}

/** Arg names a per-arg capability grant pre-binds (scalar literals). */
function boundArgsForGrant(grant: CapabilitySet | undefined): string[] {
  if (
    !grant ||
    grant === "*" ||
    typeof grant !== "object" ||
    Array.isArray(grant)
  ) {
    return [];
  }
  const out: string[] = [];
  for (const [arg, value] of Object.entries(grant)) {
    if (value === undefined) continue;
    if (value === "*") continue;
    if (Array.isArray(value)) continue;
    if (typeof value === "object") continue;
    out.push(arg);
  }
  return out.sort();
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

export interface FormatCapabilityTreeOptions {
  /** ANSI colour on/off. Default true. */
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

  lines.push(
    `${pad}${p.bold(p.cyan(tree.name))}  ${p.dim(`(${tree.manifestPath})`)}`,
  );

  // Hidden when the cycle stub left storage empty.
  if (tree.storage.path) {
    const sourceTag =
      tree.storage.source === "storage_id"
        ? p.dim("(from [agent].storage_id)")
        : p.dim("(from [agent].name)");
    lines.push(
      `${pad}  ${p.bold("storage:")} ${p.cyan(tree.storage.path)}  ${sourceTag}`,
    );
    for (const w of tree.storage.warnings) {
      lines.push(`${pad}  ${p.yellow(`⚠ ${w}`)}`);
    }
  }

  if (tree.providers.length > 0) {
    lines.push(`${pad}  ${p.bold("providers:")}`);
    for (const pl of tree.providers) {
      let label: string;
      if (pl.factoryName) {
        label = pl.handle
          ? `${p.cyan(pl.handle)}  ${p.dim(`(→ factory '${pl.factoryName}')`)}`
          : `${p.cyan(`factory '${pl.factoryName}'`)}`;
      } else if (pl.handle) {
        label = `${p.cyan(pl.handle)}  ${p.dim(`(${pl.key})`)}`;
      } else {
        label = `${p.cyan(pl.key)}  ${p.dim("(inline)")}`;
      }
      const origins =
        pl.origins.length > 0
          ? `  ${p.dim(`referenced by ${pl.origins.join(", ")}`)}`
          : "";
      lines.push(`${pad}    ${p.dim("-")} ${label}${origins}`);
      if (pl.loadError) {
        lines.push(`${pad}      ${p.yellow(`⚠ load failed: ${pl.loadError}`)}`);
      }
      if (pl.initError) {
        lines.push(`${pad}      ${p.yellow(`⚠ init failed: ${pl.initError}`)}`);
      }
      if (pl.mcpServer) {
        const mc = pl.mcpServer;
        lines.push(
          `${pad}      ${p.dim("server:")} ${p.cyan(mc.name)} ${p.dim(mc.version)} ${p.dim(`(mcp ${mc.protocolVersion})`)}`,
        );
        if (mc.advertisedButUnexposed.length > 0) {
          lines.push(
            `${pad}      ${p.dim(`advertised but unexposed (${mc.advertisedButUnexposed.length}):`)} ${p.dim(mc.advertisedButUnexposed.join(", "))}`,
          );
        }
      }
    }
  }

  {
    const h = tree.harness;
    const status = h.resolved
      ? ""
      : `  ${p.yellow("⚠ not registered at audit time")}`;
    lines.push(
      `${pad}  ${p.bold("harness:")} ${p.cyan(h.display)} ${p.dim("via")} ${sourceAttribution(h, p)}${status}`,
    );
    const cfgKeys = Object.keys(h.config);
    if (cfgKeys.length > 0) {
      lines.push(
        `${pad}    ${p.dim("config:")} ${p.dim(formatConfig(h.config))}`,
      );
    }
    // availableTools deliberately not rendered — discoverable via
    // `loom providers list`.
  }

  const layers = tree.sessionLayers ?? (tree.session ? [tree.session] : []);
  if (layers.length > 0) {
    if (layers.length === 1) {
      const [s] = layers as [(typeof layers)[number]];
      const status = s.resolved
        ? ""
        : `  ${p.yellow("⚠ not registered at audit time")}`;
      lines.push(
        `${pad}  ${p.bold("session:")} ${p.cyan(s.display)} ${p.dim("via")} ${sourceAttribution(s, p)}${status}`,
      );
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
          `${pad}    ${p.dim(`[${i}]`)} ${p.cyan(s.display)} ${p.dim("via")} ${sourceAttribution(s, p)}${status}`,
        );
        formatSessionLayerBody(s, pad, p, lines, /*layerIndent*/ "      ");
      }
    }
  }

  if (tree.secretAllowlist !== undefined) {
    const txt =
      tree.secretAllowlist === "*"
        ? p.dim("* (any name)")
        : tree.secretAllowlist.length === 0
          ? p.dim("[] (no secrets allowed)")
          : `[${tree.secretAllowlist.map((s) => p.cyan(JSON.stringify(s))).join(", ")}]`;
    lines.push(`${pad}  ${p.bold("[agent].secrets allowlist:")} ${txt}`);
  }

  if (tree.tools.length > 0) {
    lines.push(`${pad}  ${p.bold("tools:")}`);
    for (const t of tree.tools) {
      const providerStr = ` ${p.dim("via")} ${toolProviderLabel(t, p)}`;
      lines.push(
        `${pad}    ${p.dim("-")} ${p.bold(p.yellow(t.name))}${providerStr}`,
      );
      const reqStr =
        t.requires.length > 0
          ? `requires ${t.requires.map((r) => p.green(`'${r}'`)).join(", ")}`
          : "";
      const optStr =
        t.optional.length > 0
          ? `${reqStr ? " " : ""}${p.dim("optional")} ${t.optional.map((r) => p.dim(`'${r}'`)).join(", ")}`
          : "";
      const missingStr =
        t.missing.length > 0
          ? `${reqStr || optStr ? "  " : ""}${p.yellow("⚠ MISSING:")} ${p.yellow(t.missing.join(", "))}`
          : "";
      const capsLine = `${reqStr}${optStr}${missingStr}`;
      if (capsLine.length > 0) {
        lines.push(`${pad}      ${capsLine}`);
      }
      if (t.boundArgs && t.boundArgs.length > 0) {
        lines.push(
          `${pad}      ${p.dim("pre-bound args:")} ${p.cyan(t.boundArgs.join(", "))}`,
        );
      }
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

  if (tree.unresolvedSources.length > 0) {
    lines.push(
      `${pad}  ${p.bold(p.yellow("unresolved sources"))} ${p.dim("(run `loom install` to materialise):")}`,
    );
    for (const u of tree.unresolvedSources) {
      lines.push(`${pad}    ${p.dim("-")} ${p.yellow(u.spec)}`);
      lines.push(`${pad}      ${p.dim(`↳ ${u.reason}`)}`);
    }
  }

  if (tree.unresolvedTools.length > 0) {
    lines.push(`${pad}  ${p.bold(p.yellow("unresolved tools:"))}`);
    for (const u of tree.unresolvedTools) {
      lines.push(
        `${pad}    ${p.dim("-")} ${p.yellow(u.name)} ${p.dim(`(from ${u.introducedBy})`)}`,
      );
    }
  }

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

  if (tree.sessionSubagents.length > 0) {
    lines.push(`${pad}  ${p.bold("session sub-agents:")}`);
    for (const sub of tree.sessionSubagents) {
      lines.push(formatCapabilityTree(sub, { color, indent: indent + 2 }));
    }
  }

  if (tree.secrets.length > 0) {
    lines.push(`${pad}  ${p.bold("secrets:")}`);
    for (const s of tree.secrets) {
      const tag = s.required ? p.yellow("[required]") : p.dim("[optional]");
      const resolution = s.resolvedFrom
        ? p.green(`✓ ${s.resolvedFrom}`)
        : s.required
          ? p.red("✗ not found")
          : p.dim("· not set");
      const block = s.permittedByAllowlist
        ? ""
        : `  ${p.red("⚠ DENIED by [agent].secrets")}`;
      const wanters = p.dim(`(needed by ${s.requestedBy.join(", ")})`);
      lines.push(
        `${pad}    ${p.dim("-")} ${p.cyan(s.name)} ${tag} ${resolution}  ${wanters}${block}`,
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

/** Source key (package-backed) or `builtin` for harness/session headlines. */
function sourceAttribution(
  summary: FactoryAuditSummary,
  p: ReturnType<typeof makePainter>,
): string {
  if (summary.preBuilt) return p.dim("<pre-built instance>");
  if (summary.providerKey) return p.cyan(summary.providerKey);
  return p.dim("builtin");
}

/** Provider label for a tool entry. */
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

export type { ResolvedSource };
