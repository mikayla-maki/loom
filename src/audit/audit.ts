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
  /** SourceSpec for source-backed providers; undefined for factory-backed. */
  source?: SourceSpec;
  /** Local `[providers]` handle, when declared. */
  handle?: string;
  /**
   * Factory name for `[providers]` configured-factory entries (e.g.
   * `"mcp-server"`). Source-backed providers don't have one.
   */
  factoryName?: string;
  /** Where in the manifest this provider is referenced. */
  origins: string[];
  /** Set when audit tried to load this provider but couldn't. */
  loadError?: string;
  /**
   * Set when audit tried to initialise the Tools instance but the
   * underlying init() threw. Distinct from `loadError`; that's for
   * package loading. This catches spawn failures, MCP handshake
   * errors, etc.
   */
  initError?: string;
  /**
   * Populated for MCP-backed providers after a successful init().
   * Carries the server's reported name + version + protocol version
   * so reviewers see exactly what they're talking to.
   */
  mcpServer?: {
    name: string;
    version: string;
    protocolVersion: string;
    /** Names of tools the server advertised but the manifest didn't expose. */
    advertisedButUnexposed: string[];
  };
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
  /**
   * Catalog of tool names the harness can expose via
   * `Harness.availableTools()`. Populated for harness summaries only,
   * when the catalog is non-empty; reviewers can compare this with
   * the manifest's `[tools]` opt-ins (anything in the catalog but
   * not in `[tools]` is available-but-unexposed).
   *
   * Sessions don't populate this field — session-contributed tools
   * are auto-added and live on `SessionAuditSummary.contributedTools`.
   */
  availableTools?: string[];
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
   * Per-agent storage root: absolute path, identifier source
   * (`storage_id` override vs `name` default), and any collision
   * warnings produced when the storage dir was opened (e.g. a
   * different manifest path previously used the same id).
   */
  storage: {
    path: string;
    source: "storage_id" | "name";
    warnings: string[];
  };
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
    /**
     * Model-visible JSON Schema (i.e. POST-narrowing for MCP-style
     * argument-bound tools). Only populated when the tool resolved
     * successfully; useful for reviewing what the model sees.
     */
    inputSchema?: unknown;
    /**
     * Names of arguments pre-bound via `[capabilities]` for
     * argument-binding tools. The bound values themselves are NOT
     * surfaced (they may include user-secret-ish literals).
     */
    boundArgs?: string[];
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
 * Audit-time options. Currently empty: audit has one behaviour
 * (succeed cleanly, or throw `AuditError` with the partial tree).
 * Reserved for future flags that genuinely vary semantics, not for
 * lenient/strict toggles — "how thoroughly is this manifest
 * actually wired up?" should always have one honest answer.
 */
export type AuditOptions = Record<string, never>;

const DEFAULT_TOP_LEVEL_CAPABILITIES: Capabilities = {
  bash: { subprocess: "*", paths: ["./"] },
  read_file: { paths: ["./"] },
  write_file: { paths: ["./"] },
  edit_file: { paths: ["./"] },
};

/**
 * Run a static audit against a manifest. Either the manifest is
 * fully resolvable — in which case audit returns a `CapabilityTree`
 * describing what would happen at boot — or it isn't, in which case
 * audit throws `AuditError` with the partial tree + structured
 * problem list attached.
 *
 * There is no "lenient" mode. Before MCP, audit could be a pure
 * static walk that always answered; now that MCP requires init()
 * to populate tool caches, audit may not be able to answer at all,
 * and pretending otherwise would let broken manifests look fine.
 *
 * Callers who want to inspect a partially-resolved tree (UI
 * authoring tools, IDE integrations) should catch `AuditError` and
 * read `error.tree` + `error.health`.
 */
export async function auditAgent(
  source: string | AgentManifest,
  _options: AuditOptions = {},
): Promise<CapabilityTree> {
  void _options; // reserved; see AuditOptions.
  const tree = await auditAgentInner(source, new Set());
  const health = summariseAuditHealth(tree);
  if (health.totalProblems > 0) {
    throw new AuditError(formatAuditFailure(tree.name, health), tree, health);
  }
  return tree;
}

/**
 * Thrown by `auditAgent()` when a manifest doesn't fully resolve.
 * Carries the partial tree + structured health so callers can
 * inspect both without re-running.
 */
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
 * Audit-health summary: every condition that means "this manifest
 * is NOT fully resolved." Recursive over the agent tree — a
 * sub-agent that doesn't resolve makes the parent unsoundly
 * executable too, so `totalProblems` rolls up through every
 * reachable sub-agent. Use the per-node counts (`unresolvedSources`
 * etc.) for direct attribution; use `subagents` to walk the
 * recursive structure.
 */
export interface AuditHealth {
  /**
   * Name of the agent this health belongs to. Lets callers walk
   * `subagents` and identify which sub-agent each child belongs
   * to without cross-referencing the tree.
   */
  agentName: string;
  /**
   * Recursive total: this node's direct problems plus every
   * sub-agent's `totalProblems`. Zero means the manifest AND every
   * sub-agent it can reach are fully resolved. Audit succeeds iff
   * this is zero.
   */
  totalProblems: number;
  /**
   * This node's direct problems, sum of the per-category counts
   * below. Useful for "which level is broken?" attribution.
   */
  directProblems: number;
  /** Sources audit couldn't load (run `loom install`). */
  unresolvedSources: number;
  /**
   * Providers that loaded but failed to construct or initialise.
   * Distinct from `unresolvedSources` because the package was found;
   * the side-effecting `init()` is what broke (MCP server didn't
   * start, declared secret missing, etc.).
   */
  providerInitErrors: number;
  /**
   * Tools named in `[tools]` that no provider claimed at audit time.
   * Typically follows a provider load/init failure but can also
   * happen when a provider doesn't recognise the requested name
   * (typo in `mcp_tool`, etc.).
   */
  unresolvedTools: number;
  /**
   * Tools whose `requires` capability kinds aren't granted by
   * `[capabilities]`. The runtime fails boot on these via
   * `assertRequires`; audit should match.
   */
  toolsMissingRequires: number;
  /**
   * Sub-agent capability ceiling violations (a sub-agent grants
   * something the parent doesn't allow).
   */
  capabilityCeilingViolations: number;
  /**
   * Tool `audit()` findings with severity `"error"` (e.g. bash
   * reports sandbox-exec missing on macOS). These would block boot
   * via the runtime audit.
   */
  toolAuditErrors: number;
  /**
   * Recursive children — one entry per reachable sub-agent
   * (tool-declared via `tool.dependencies.subagents` AND
   * session-declared via `session.dependencies.subagents`). The
   * order mirrors the audit tree.
   */
  subagents: AuditHealth[];
}

export function summariseAuditHealth(tree: CapabilityTree): AuditHealth {
  const unresolvedSources = tree.unresolvedSources.length;
  // `loadError` providers are already counted under `unresolvedSources`.
  // `initError` is the disjoint category: package loaded but the
  // factory's create()/init() threw.
  const providerInitErrors = tree.providers.filter(
    (p) => p.initError && !p.loadError,
  ).length;
  // The audit walker plants a synthetic `(cycle)` marker when it
  // bottoms out on a recursive sub-agent declaration. That's a
  // diagnostic for the user, not a real unresolved tool — the
  // *parent* (the one declaring the cycle) is the place the
  // problem materially lives, and is counted via its own
  // `unresolvedTools` etc. Filter the synthetic markers so they
  // don't double-count.
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

  // Recurse into every reachable sub-agent: those declared by tools
  // (`tool.dependencies.subagents`) plus those declared by sessions
  // (`session.dependencies.subagents`, surfaced as `sessionSubagents`).
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
  // Count how many distinct agents in the tree have a non-zero
  // direct-problem count. Audit consumers want to know "is this
  // broken at the top level, deep in a sub-agent, or both?" before
  // they start reading individual messages.
  const affectedAgents = countAffectedAgents(h);
  const headerSuffix =
    affectedAgents > 1 ? ` across ${affectedAgents} agent(s)` : "";
  const lines: string[] = [
    `'${name}' is not fully resolved (${h.totalProblems} problem(s)${headerSuffix}):`,
  ];
  appendHealthLines(h, [], lines);
  return lines.join("\n");
}

/**
 * Walk the recursive health, emitting a section per agent that has
 * direct problems. `path` accumulates the sub-agent chain so deep
 * problems are easy to locate ("parent → child → grandchild").
 */
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

  // Cycle detection.
  const cycleKey = manifest.manifestPath ?? `<inline:${manifest.name}>`;
  if (seenManifests.has(cycleKey)) {
    return {
      manifestPath,
      name: manifest.name,
      grants: {},
      // Storage isn't resolved for the cycle stub — we never
      // reach the side-effecting path. Surface a placeholder so
      // the field is non-optional but consumers see it's empty.
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
  // Resolve system prompt for parity with runAgent (validates path-form).
  void (await resolveSystemPrompt(manifest, baseDir));

  // ─── resolution ─────────────────────────────────────────────────────
  const builtinToolNames = new Set(nativeBuiltinNames());
  const resolved = resolveManifest(manifest, { builtinToolNames });

  // ─── provider loading (lenient) ─────────────────────────────────
  // Same machinery as `runAgent` (via `runtime/boot.js`), but where
  // the runtime treats any provider load failure as fatal, audit
  // collects them in `unresolvedSources` and keeps walking the tree.
  //
  // Storage is resolved here too so plugins that read `ctx.storage`
  // during init() see a real path. Collision warnings surface on
  // the audit tree (see `tree.storage.warnings`) rather than via
  // console.warn — audit's contract is "return everything, log
  // nothing."
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

  // Best-effort secrets bundle so audit can construct + init
  // provider Tools whose `create()` consults secrets (MCP being
  // the motivating case — it injects them into the spawned
  // server's env). `allowMissingRequired: true` keeps audit non-
  // fatal: missing secrets simply aren't in the resulting map; the
  // factory will surface that as `initError` on the provider
  // summary if it actually can't proceed.
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
    // Wire instance → summary lookup so the materialisation loop
    // below can attach init errors / mcp-server info to the right
    // entry. Source-backed: every instance pointing at this source
    // shares the same summary.
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
  // Configured-factory `[providers]` entries have no SourceSpec
  // — they're absent from `resolved.sources`. Add a synthetic
  // ProviderSummary per factory-backed instance so reviewers see
  // the MCP-style provider in audit output.
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
  for (const [i, layer] of sessionBindings.entries()) {
    let linkInstance: Session | null = null;
    let linkError: string | undefined;
    if (isPreBuiltSessionLayer(layer)) {
      // Pre-built instance — nothing to construct, can't fail here.
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
    void linkInstance; // populated below from per-link queries
  }
  if (auditedSessionLinks.length === 1) {
    // Length-check above narrows index 0 at runtime; TS needs help.
    const [only] = auditedSessionLinks as [Session];
    auditSession = only;
  } else if (auditedSessionLinks.length > 1) {
    auditSession = new ChainedSession(auditedSessionLinks);
  }

  // Per-link tool / trusted-path discovery. Querying per link lets us
  // attribute contributions to the layer that produced them.
  const sessionToolBindings: typeof resolved.tools = [];
  const claimedSessionTools = new Set(resolved.tools.map((b) => b.toolName));
  let cursor = 0;
  for (const [i, layer] of sessionBindings.entries()) {
    // Find the i'th layer's instance among auditedSessionLinks.
    // perLinkContributions[i].constructionError set ⇒ no instance
    // was created and `cursor` skips it. Both lookups are invariants
    // of how we just built the parallel arrays, hence the runtime
    // guards (rather than `!`) to surface any future drift.
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

  // ─── effective grants ───────────────────────────────────────────
  const effectiveGrants: Capabilities =
    manifest.tools === undefined && manifest.capabilities === undefined
      ? DEFAULT_TOP_LEVEL_CAPABILITIES
      : (manifest.capabilities ?? {});

  // ─── tool resolution ──────────────────────────────────
  const native = buildNativeTools();
  const auditAgentRef: Agent = {
    manifest,
    harness: stubHarness(),
    session: stubSession(),
    systemPromptCore: "",
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
      // construction failure (e.g. MCP missing a declared secret,
      // bad config). Tools routing through this instance will
      // surface as `unresolvedTools`; also record the error on the
      // summary so reviewers don't have to guess why.
      if (summary) {
        summary.initError = (e as Error).message;
      }
      continue;
    }
    providerByInstanceId.set(p.id, tools);
    auditedProviderTools.push(tools);
    // Best-effort init() so MCP server info + tool cache populate
    // before we walk tool bindings. Failures get attributed to the
    // provider summary; the tools route through unresolvedTools.
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
    // Pull MCP server info out of the freshly-inited Tools when the
    // instance is an MCP factory — we identify it duck-typed so we
    // don't need a runtime import of McpServerTools (audit lives
    // upstream of builtins/provider).
    if (summary) attachMcpServerInfo(summary, tools, resolved, p.id);
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

  // Mirror the runtime's synthetic `"(harness)"` Tools instance.
  // Resolver emits `(harness)` bindings when `[tools.X] provider = "..."`
  // matches the harness factory name (e.g. `provider = "anthropic"`).
  // We construct the harness best-effort here so harness-routed
  // tool bindings can be resolved against its `availableTools` /
  // `resolveTool`. The harness factory sees the same lenient secret
  // bundle the rest of audit uses (real keys when present, empty
  // when not) plus a synthetic `audit-mode` stub for required keys
  // it didn't find — the latter keeps audit fully informative even
  // when no API key is configured (harness construction would
  // otherwise throw, leaving `(harness)`-routed tools dangling).
  let auditHarness: Harness | undefined;
  let auditHarnessAvailableTools: string[] = [];
  if (resolved.harness) {
    try {
      const harnessFactory = lookupFactoryByBinding(
        resolved.harness.factoryName,
        resolved.harness.source,
        getHarnessFactory,
      );
      // Synthesise placeholder values for required secrets the audit
      // couldn't fetch. The audit doesn't actually call the API; it
      // just needs the factory's constructor to succeed so we can
      // ask the resulting harness for its `availableTools` catalog.
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
      /* harness construction failed — tools routed through it
         will show up as unresolved, which is the right signal */
    }
  } else if (!("provider" in manifest.harness)) {
    // Pre-built `Harness` instance — no factory binding, but we can
    // still introspect it for the audit. There's no resolver-emitted
    // `(harness)` binding to satisfy (the resolver doesn't know a
    // factory name for pre-built instances), but `availableTools`
    // is informational.
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
      //
      // We always prefix with `session:` so the row reads symmetrically
      // with `harness:anthropic` for harness-exposed tools — making
      // it visually obvious which kind of indirection owns the tool.
      const layerIdx = perLinkContributions.findIndex((slot) =>
        slot.contributedTools.includes(binding.toolName),
      );
      const layerBinding =
        layerIdx >= 0 ? sessionBindings[layerIdx] : undefined;
      const layerLabel = layerBinding
        ? sessionLayerLabel(layerBinding)
        : undefined;
      // Only factory-backed layers carry source/handle; pre-built
      // instances have neither (we still prefix — the label says
      // "<pre-built Session instance>" so the prefix isn't redundant).
      if (layerBinding && !isPreBuiltSessionLayer(layerBinding)) {
        if (layerBinding.source) {
          providerKey = sourceSpecKey(layerBinding.source);
        }
      }
      providerHandle = layerLabel
        ? `session:${layerLabel}`
        : "session:<unknown>";
    } else if (binding.providerInstanceId === "(harness)") {
      // Harness-exposed server tool. Attribute it to the harness
      // factory (e.g. "anthropic") so the audit row doesn't render
      // as `provider: builtin` — these tools are very much not
      // builtins; they're dispatched API-side by the harness's
      // upstream provider.
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
        // Factory-backed (e.g. MCP) — use the synthetic provider
        // summary key so the audit attribution lines up.
        providerKey = `factory:${instance.factoryName}#${instance.id}`;
      }
      if (instance?.providerHandle) {
        providerHandle = instance.providerHandle;
      }
    }
    // For argument-binding tools (MCP), surface the bound arg names
    // so reviewers see what `[capabilities]` pre-fills without
    // having to mentally simulate `applyArgGrant`.
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

  // After walking all tool bindings, compute the
  // "advertised but unexposed" set per factory-backed provider so
  // audit reviewers can see what the underlying MCP server offered
  // that the manifest didn't opt into.
  for (const [instanceId, summary] of providerSummariesByInstanceId) {
    if (!summary.mcpServer) continue;
    const exposed = new Set<string>();
    for (const binding of resolved.tools) {
      if (binding.providerInstanceId !== instanceId) continue;
      // The dispatched MCP-tool name is either `config.mcp_tool` or
      // the model-facing name. Reflect both for safety.
      const dispatched =
        typeof binding.toolConfig.mcp_tool === "string"
          ? (binding.toolConfig.mcp_tool as string)
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
  const secrets = collectSecrets(manifest, resolved, resolvedTools, toolsIndex);

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

  // ─── harness / session summaries ──────────────────────────
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
    storage: {
      path: storage.path,
      source: storage.source,
      // Storage collision warnings only surface on the top-level
      // audit. A sub-agent inherits its identity from a parent that
      // already opened the same storage (and may have surfaced the
      // collision there); repeating the warning per sub-agent is
      // noise the user can't act on from inside a sub-tree.
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

// ─── factory summaries ───────────────────────────────────────────────────

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
    // Shouldn't happen — manifest.harness has `kind` but resolver
    // didn't produce a binding. Defensive fallback.
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

/**
 * Human-readable identifier for a `ResolvedSessionLayer`, used in
 * audit error messages and origin labels. Factory-backed layers
 * fall back to their factory name; pre-built instances render as
 * `(pre-built)`.
 */
function sessionLayerLabel(layer: ResolvedSessionLayer): string {
  return isPreBuiltSessionLayer(layer)
    ? "(pre-built)"
    : (layer.providerHandle ?? layer.factoryName);
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
    if (!Object.hasOwn(grant, k)) missing.push(k);
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
 *   - every provider-Tools contribution's static `secrets` AND
 *     per-instance `instanceSecretNeeds(config)` (the MCP factory's
 *     `secrets = { LOOM_NAME = "ENV_VAR" }` map flows through this
 *     path)
 *
 * The provider walk mirrors the runtime's `collectPhase1SecretNeeds`
 * so reviewers see the same set of names the SDK would actually
 * pull from the secret store at boot.
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
  // Session factory needs (per chain link). Pre-built instances
  // bring their own state; the audit can't see what secrets they
  // closed over at construction time.
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
  // Tool needs.
  for (const [name, tool] of tools) {
    addNeeds(tool.secrets, `tool:${name}`);
  }

  // Provider-Tools contribution needs. Walk every materialised
  // provider instance, locate its contribution registration (via
  // the source-indexed `toolsIndex` for source-backed providers, or
  // the built-in/SDK Tools-factory registry for configured-factory
  // entries), and capture both the static `secrets` field and the
  // per-instance `instanceSecretNeeds(config)` map. This is what
  // surfaces e.g. an MCP server's `secrets = { MOCK_API_KEY = "…" }`
  // on the audit tree without having to call into the live process.
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
    // Label: prefer the user-declared `[providers]` handle when
    // present so reviewers can trace a secret back to the manifest
    // entry that asked for it; fall back to the contribution name.
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

/**
 * Render an origin label for a factory-backed `ProviderInstance`.
 * Mirrors `resolver.ts`'s `originLabel` but lives here so the audit
 * doesn't need to import the resolver's internals.
 */
function originLabelFor(
  p: ReturnType<typeof resolveManifest>["providers"][number],
): string {
  if (p.origin.kind === "handle-factory") {
    return `(via [providers].${p.origin.providerHandle} → factory '${p.origin.factoryName}')`;
  }
  return "(factory-backed)";
}

/**
 * If `tools` looks like an MCP `McpServerTools` instance — we duck-
 * type via the public `serverInfo` / `toolsCache` fields — attach
 * the server info to the provider summary so reviewers see
 * `mcp-server-name 1.2.3` in the audit output.
 */
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

/**
 * Surface the arg names that a per-arg capability grant pre-binds.
 * Used by the audit output so reviewers can see which inputs the
 * model never gets to choose.
 */
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
    // Scalar: it's a literal binding.
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

  // Storage. Hidden when the cycle stub left it empty.
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

  // Providers.
  if (tree.providers.length > 0) {
    lines.push(`${pad}  ${p.bold("providers:")}`);
    for (const pl of tree.providers) {
      // Factory-backed providers (e.g. MCP) get a `→ factory` hint.
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

  // Harness. Headline reads `harness: <name> via <source>` so it
  // mirrors the tools section's `- <name> via <provider>` format.
  // `source` here is the source key (when factory-backed) or
  // `builtin` (when the factory is in the built-in registry).
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
    // The catalog of harness-exposed tools (`availableTools`) is
    // intentionally NOT rendered here — it's discoverable via
    // `loom providers list` (which surfaces built-in harnesses
    // alongside installed npm provider packages). Keeping it out of
    // the per-agent audit avoids a tutorial sentence on every run.
  }

  // Session. Renders the layers as N indented blocks under a single
  // `session:` heading. Singleton sessions (no `layers`) produce the
  // same one-block output as before.
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
      // Headline: name + provider attribution. The `via` reads
      // naturally and replaces the older two-line layout (where
      // `provider:` lived on its own row). Origin (`[tools.X]` /
      // `(session link N: layer)`) is elided because the `via`
      // label already carries the kind+name; the per-source
      // breakdown lives in `providers:` at the top.
      const providerStr = ` ${p.dim("via")} ${toolProviderLabel(t, p)}`;
      lines.push(
        `${pad}    ${p.dim("-")} ${p.bold(p.yellow(t.name))}${providerStr}`,
      );
      // Capability summary on its own sub-line, with MISSING
      // annotations folded in alongside. Elide entirely when the
      // tool has no required/optional kinds and nothing's missing
      // — the row collapses to a single line in that case.
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
      // The grant itself is rendered once in the `capabilities granted:`
      // section below — repeating it per tool just doubles the noise.
      // Bound args render below.
      if (t.boundArgs && t.boundArgs.length > 0) {
        // Surface MCP-style pre-bindings inline so reviewers see
        // which args the model never gets to choose.
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

  // The `capabilities granted:` summary block was removed: it just
  // restates each tool's manifest grant verbatim, which reviewers
  // can already read in `agent.toml`. The audit's job is structural
  // — it flags MISSING required kinds inline on each tool's caps
  // line. Grant *values* aren't the audit's concern.

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

  // Secrets. `requestedBy` flows inline rather than in a `(needed by ...)`
  // parenthetical — it's the actually-informative bit for reviewers
  // chasing who wants a secret.
  if (tree.secrets.length > 0) {
    lines.push(`${pad}  ${p.bold("secrets:")}`);
    for (const s of tree.secrets) {
      const tag = s.required ? p.yellow("[required]") : p.dim("[optional]");
      const block = s.permittedByAllowlist
        ? ""
        : `  ${p.red("⚠ DENIED by [agent].secrets")}`;
      const wanters = p.dim(s.requestedBy.join(", "));
      lines.push(
        `${pad}    ${p.dim("-")} ${p.cyan(s.name)} ${tag}  ${wanters}${block}`,
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
  // Source attribution now folds into the heading via `via <source>`;
  // body just carries the layer's config, contributions, trusted
  // paths, and any construction error.
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
 * Source-only attribution for harness/session headlines: returns just
 * the source key (when factory-backed by a package) or `builtin`
 * (when sourced from the built-in registry). Drops the provider
 * handle because the headline already carries it (e.g. `harness:
 * anthropic via builtin` instead of `harness: anthropic via anthropic`).
 */
function sourceAttribution(
  summary: FactoryAuditSummary,
  p: ReturnType<typeof makePainter>,
): string {
  if (summary.preBuilt) return p.dim("<pre-built instance>");
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
