/**
 * Static capability audit — instantiates the native provider against an
 * agent manifest and prints what it would expose. No LLM is ever invoked,
 * and no extension providers are loaded; audit is conservative and
 * deterministic. Extension-supplied tools don't appear in the tree
 * (they'd require running provider init, which can have side effects
 * like opening MCP connections).
 *
 * The tree shows three axes per agent:
 *   - GRANTS: per-tool capability grants from `[capabilities]`
 *   - REQUIRES: every kind each native-resolved tool declares it needs
 *     (regardless of whether it's granted; surfaces missing grants)
 *   - SECRETS: every secret name any component declares it needs
 *     (regardless of the [agent].secrets allowlist; surfaces secrets
 *     that would be denied at boot)
 */

import * as path from "node:path";

import { resolveSystemPrompt } from "../manifest/resolver.js";
import { getHarnessFactory, getSessionFactory } from "../extensions/index.js";
import { buildNativeProvider } from "../extensions/provider/native.js";
import { parseAgentManifest } from "../manifest/parser.js";
import type {
  AgentManifest,
  Capabilities,
  CapabilitySet,
  SecretAllowlist,
} from "../types/manifest.js";
import type {
  Agent,
  AuditFinding,
  Tool,
  ToolConfig,
} from "../types/interfaces.js";

export interface SecretRequest {
  name: string;
  required: boolean;
  requestedBy: string[];
  /** Whether the manifest's [agent].secrets allowlist permits this name. */
  permittedByAllowlist: boolean;
}

export interface CapabilityTree {
  manifestPath: string;
  name: string;
  /** The agent's `[capabilities]` table — per-tool grants. */
  grants: Capabilities;
  /** The agent's `[agent].secrets` allowlist (or undefined when unset). */
  secretAllowlist?: SecretAllowlist;
  /**
   * Each tool the native provider could resolve, with its declared
   * capability requires/optionals, the granted set, the source that
   * introduced it, and any sub-agent trees reachable through
   * `tool.dependencies.subagents`.
   */
  tools: Array<{
    name: string;
    /** Static `Tool.requires`. Empty when the tool needs nothing. */
    requires: string[];
    /** Static `Tool.optional`. Empty when the tool advertises no optional kinds. */
    optional: string[];
    /** The granted set the tool was constructed with (may be `"*"` or a per-kind map). */
    granted: CapabilitySet | undefined;
    /**
     * Required kinds NOT present in the grant. Empty when the grant
     * satisfies every requirement; non-empty means the agent would
     * fail to boot.
     */
    missing: string[];
    /**
     * Findings from `Tool.audit()` — environment / readiness checks
     * the tool reports about its own runtime preconditions. Empty
     * when the tool didn't implement `audit()`.
     */
    findings: AuditFinding[];
    introducedBy: string;
    /**
     * Sub-agent trees this tool declares it may spawn. Empty when
     * the tool has no declared sub-agents. Each entry is the audit
     * tree of the corresponding `AgentManifest`, recursively.
     */
    subagents: CapabilityTree[];
  }>;
  /**
   * Every secret name a component of this agent declares it needs. Built
   * from harness + session factory `secrets` and each tool's declared
   * `secrets`. Provider-factory secrets aren't included because audit
   * doesn't load extensions — see the comment in `collectSecrets`.
   */
  secrets: SecretRequest[];
  /**
   * Sub-agent trees this manifest's session declares it may spawn
   * via `Session.dependencies.subagents`. Empty when none.
   */
  sessionSubagents: CapabilityTree[];
  /**
   * Tool refs the manifest brought in (top-level `[tools]`) that
   * couldn't be resolved by the native provider — e.g. extension
   * tools, since audit doesn't load `[extensions]`. Useful for
   * diagnostics and for spotting gaps in sub-manifest closures.
   */
  unresolvedTools: Array<{ name: string; introducedBy: string }>;
}

const DEFAULT_TOP_LEVEL_TOOLS: Record<string, ToolConfig> = {
  bash: {},
  read_file: {},
  write_file: {},
  find: {},
};

const DEFAULT_TOP_LEVEL_CAPABILITIES: Capabilities = {
  bash: { subprocess: "*", paths: ["./"] },
  read_file: { paths: ["./"] },
  write_file: { paths: ["./"] },
  find: { paths: ["./"] },
};

const TOP_LEVEL = "(top-level)";

export async function auditAgent(
  source: string | AgentManifest,
): Promise<CapabilityTree> {
  return auditAgentInner(source, new Set());
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

  // Cycle detection. A sub-manifest that references back to one of its
  // ancestors short-circuits with an empty tree (the parent already
  // recorded its capabilities). The seen set is keyed by manifestPath
  // when available, otherwise by name.
  const cycleKey = manifest.manifestPath ?? `<inline:${manifest.name}>`;
  if (seenManifests.has(cycleKey)) {
    return {
      manifestPath,
      name: manifest.name,
      grants: {},
      tools: [],
      secrets: [],
      sessionSubagents: [],
      unresolvedTools: [{ name: "(cycle)", introducedBy: cycleKey }],
    };
  }
  const nextSeen = new Set(seenManifests);
  nextSeen.add(cycleKey);

  const baseDir = manifest.manifestPath
    ? path.dirname(manifest.manifestPath)
    : process.cwd();
  // Resolve system prompt for parity with runAgent (validates path-form).
  void (await resolveSystemPrompt(manifest, baseDir));

  // Build the same tool-ref list runAgent builds.
  const refs: Array<{ name: string; config: ToolConfig; origin: string }> = [];
  const topLevel = manifest.tools ?? DEFAULT_TOP_LEVEL_TOOLS;
  for (const [name, config] of Object.entries(topLevel)) {
    refs.push({ name, config, origin: TOP_LEVEL });
  }
  // Mirror runAgent's effective-capabilities computation: when both
  // [tools] and [capabilities] are absent, the default cap bundle
  // applies; otherwise [capabilities] (or empty) is the source of truth.
  const effectiveGrants: Capabilities =
    manifest.tools === undefined && manifest.capabilities === undefined
      ? DEFAULT_TOP_LEVEL_CAPABILITIES
      : (manifest.capabilities ?? {});

  // Run only the native provider. Extension providers stay un-audited.
  const native = buildNativeProvider();
  // Synthetic Agent ref for native.resolveTool. Audit doesn't run the
  // session/harness; the Agent's runtime fields are stubs that throw
  // if anyone reads through them — and no native builtin does.
  const auditAgentRef: Agent = {
    harness: stubHarness(),
    session: stubSession(),
    systemPromptCore: "",
    agentName: manifest.name,
  };
  const tools: CapabilityTree["tools"] = [];
  const resolvedTools = new Map<string, Tool>();
  const unresolvedTools: CapabilityTree["unresolvedTools"] = [];
  for (const ref of refs) {
    const grant = effectiveGrants[ref.name];
    const t = await Promise.resolve(
      native.resolveTool(ref.name, ref.config, auditAgentRef, grant),
    );
    if (!t) {
      unresolvedTools.push({ name: ref.name, introducedBy: ref.origin });
      continue;
    }
    resolvedTools.set(ref.name, t);
    // Recurse into the tool's declared sub-agents.
    const subagents: CapabilityTree[] = [];
    for (const sub of t.dependencies?.subagents ?? []) {
      subagents.push(await auditAgentInner(sub, nextSeen));
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
    tools.push({
      name: ref.name,
      requires,
      optional,
      granted: grant,
      missing,
      findings,
      introducedBy: ref.origin,
      subagents,
    });
  }
  await native.close();

  const secrets = collectSecrets(manifest, resolvedTools, manifest.secrets);

  // Recurse into the manifest's session deps. Audit doesn't instantiate
  // sessions (factories may have side effects), but session
  // instances passed inline carry their declared `dependencies`
  // directly. For the common factory-form case this is empty; the
  // tree still reports it for parity.
  const sessionSubagents: CapabilityTree[] = [];
  if (manifest.session && !("provider" in manifest.session)) {
    const sess = manifest.session;
    for (const sub of sess.dependencies?.subagents ?? []) {
      sessionSubagents.push(await auditAgentInner(sub, nextSeen));
    }
  }

  return {
    manifestPath,
    name: manifest.name,
    grants: effectiveGrants,
    ...(manifest.secrets !== undefined
      ? { secretAllowlist: manifest.secrets }
      : {}),
    tools,
    secrets,
    sessionSubagents,
    unresolvedTools,
  };
}

/** Required kinds not present in the grant (drives boot pass/fail). */
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
 * Roll up every secret name a component of this agent declares.
 *
 * Sources:
 *   - harness factory's `secrets` (if `[harness]` references one by name)
 *   - session factory's `secrets`
 *   - every native-resolved tool's `secrets`
 *
 * NOT included: extension-added provider factories. Audit doesn't load
 * `[extensions]` packages.
 */
function collectSecrets(
  manifest: AgentManifest,
  tools: Map<string, Tool>,
  allowlist: SecretAllowlist | undefined,
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

  if ("provider" in manifest.harness) {
    try {
      const f = getHarnessFactory(manifest.harness.provider);
      addNeeds(f.secrets, `harness:${f.name}`);
    } catch {
      /* unknown harness — skip */
    }
  }
  if (manifest.session && "provider" in manifest.session) {
    try {
      const f = getSessionFactory(manifest.session.provider);
      addNeeds(f.secrets, `session:${f.name}`);
    } catch {
      /* unknown session — skip */
    }
  }
  for (const [name, tool] of tools) {
    addNeeds(tool.secrets, `tool:${name}`);
  }

  for (const k of required.keys()) optional.delete(k);

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

function stubHarness(): import("../types/interfaces.js").Harness {
  return {
    run: async () => {
      throw new Error(
        "audit: harness.run() called — audit doesn't execute turns",
      );
    },
  };
}

function stubSession(): import("../types/interfaces.js").Session {
  return {
    push: async () => {
      throw new Error("audit: session.push() called");
    },
    pull: async () => [],
  };
}

/** Pretty-print a CapabilityTree as a tree of strings (for CLI use). */
export function formatCapabilityTree(tree: CapabilityTree, indent = 0): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  lines.push(`${pad}${tree.name}  (${tree.manifestPath})`);
  // Grants
  const grantKeys = Object.keys(tree.grants);
  if (grantKeys.length > 0) {
    lines.push(`${pad}  capabilities granted:`);
    for (const [k, v] of Object.entries(tree.grants)) {
      lines.push(`${pad}    - ${k}: ${formatGrant(v)}`);
    }
  } else {
    lines.push(`${pad}  capabilities granted: (none)`);
  }
  // Secret allowlist
  if (tree.secretAllowlist !== undefined) {
    const txt =
      tree.secretAllowlist === "*"
        ? "* (any name)"
        : tree.secretAllowlist.length === 0
          ? "[] (no secrets allowed)"
          : `[${tree.secretAllowlist.map((s) => JSON.stringify(s)).join(", ")}]`;
    lines.push(`${pad}  [agent].secrets allowlist: ${txt}`);
  }
  if (tree.tools.length > 0) {
    lines.push(`${pad}  tools:`);
    for (const t of tree.tools) {
      const reqStr =
        t.requires.length > 0
          ? ` requires ${t.requires.map((r) => `'${r}'`).join(", ")}`
          : "";
      const optStr =
        t.optional.length > 0
          ? ` optional ${t.optional.map((r) => `'${r}'`).join(", ")}`
          : "";
      const missingStr =
        t.missing.length > 0 ? `  ⚠ MISSING: ${t.missing.join(", ")}` : "";
      lines.push(
        `${pad}    - ${t.name} (from ${t.introducedBy}):${reqStr}${optStr}${missingStr}`,
      );
      lines.push(`${pad}      granted: ${formatGrant(t.granted)}`);
      for (const f of t.findings) {
        const icon =
          f.severity === "ok" ? "✓" : f.severity === "warning" ? "⚠" : "✗";
        lines.push(`${pad}      ${icon} ${f.message}`);
        if (f.remediation) {
          lines.push(`${pad}        → ${f.remediation}`);
        }
      }
      for (const sub of t.subagents) {
        lines.push(`${pad}      sub-agent:`);
        lines.push(formatCapabilityTree(sub, indent + 4));
      }
    }
  }
  if (tree.unresolvedTools.length > 0) {
    lines.push(`${pad}  unresolved tools (audit doesn't load extensions):`);
    for (const u of tree.unresolvedTools) {
      lines.push(`${pad}    - ${u.name} (from ${u.introducedBy})`);
    }
  }
  if (tree.sessionSubagents.length > 0) {
    lines.push(`${pad}  session sub-agents:`);
    for (const sub of tree.sessionSubagents) {
      lines.push(formatCapabilityTree(sub, indent + 2));
    }
  }
  if (tree.secrets.length > 0) {
    lines.push(`${pad}  secrets:`);
    for (const s of tree.secrets) {
      const tag = s.required ? "required" : "optional";
      const block = s.permittedByAllowlist
        ? ""
        : "  ⚠ DENIED by [agent].secrets";
      lines.push(
        `${pad}    - ${s.name} [${tag}] (needed by ${s.requestedBy.join(", ")})${block}`,
      );
    }
  }
  return lines.join("\n");
}

function formatGrant(v: CapabilitySet | undefined): string {
  if (v === undefined) return "(none)";
  if (v === "*") return "*";
  return JSON.stringify(v);
}
