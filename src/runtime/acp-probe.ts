/**
 * Lightweight capability probe — derives the `AgentCapabilities` set
 * to advertise in `initialize` from a manifest, *without* booting the
 * full agent.
 *
 * The full boot (secrets, providers, tool resolution, audit) is
 * deferred to `session/new` where the workspace cwd is known. The
 * probe needs only:
 *   1. Parse the manifest.
 *   2. Resolve bindings (factory names).
 *   3. Load any provider sources that contribute the named factories.
 *   4. Look up factories by name and call their static
 *      `acpCapabilities?(config)`.
 *
 * Built-in-only manifests (anthropic + memory, openai + file, etc.)
 * skip step 3 entirely, so the probe is essentially free.
 */
import * as path from "node:path";

import { getHarnessFactory, getSessionFactory } from "../builtins/index.js";
import { parseAgentManifest } from "../manifest/parser.js";
import { resolveManifest } from "../manifest/resolver.js";
import { nativeBuiltinNames } from "../builtins/provider/native.js";
import { loadManifestProviders } from "./boot.js";
import { LOOM_VERSION } from "../sdk/run-agent.js";

import type {
  AcpCapabilityContribution,
  FactoryContext,
  HarnessFactory,
  SessionFactory,
} from "../types/interfaces.js";
import type { AgentManifest } from "../types/manifest.js";
import {
  aggregateAcpCapabilities,
  DEFAULT_CLIENT_ACP_CAPABILITIES,
  type AgentAcpCapabilities,
  type ClientAcpCapabilities,
} from "./acp-capabilities.js";

export interface ProbeResult {
  agentCapabilities: AgentAcpCapabilities;
  agentInfo: { name: string; version: string; title?: string };
}

/**
 * Probe an `agent.toml` for its advertised capabilities. Pure with
 * respect to the agent runtime — does not boot the harness, instantiate
 * tools, load secrets, or change `process.cwd()`.
 *
 * Provider sources referenced by the manifest are loaded (their
 * `register()` runs to contribute factories) since otherwise we
 * wouldn't know what a provider-backed harness can do. Provider
 * registration is required to be cheap and idempotent.
 */
export async function probeAcpCapabilities(
  manifestPath: string,
  clientCapabilities: ClientAcpCapabilities = DEFAULT_CLIENT_ACP_CAPABILITIES,
): Promise<ProbeResult> {
  const manifest: AgentManifest = await parseAgentManifest(manifestPath);
  return probeAcpCapabilitiesFromManifest(
    manifest,
    manifestPath,
    clientCapabilities,
  );
}

/**
 * Same as `probeAcpCapabilities` but takes a parsed manifest. Useful
 * for in-process tests that already have a manifest object.
 */
export async function probeAcpCapabilitiesFromManifest(
  manifest: AgentManifest,
  manifestPath: string | undefined,
  clientCapabilities: ClientAcpCapabilities = DEFAULT_CLIENT_ACP_CAPABILITIES,
): Promise<ProbeResult> {
  const builtinToolNames = new Set(nativeBuiltinNames());
  const resolved = resolveManifest(manifest, { builtinToolNames });

  const baseDir = manifestPath
    ? path.dirname(path.resolve(manifestPath))
    : process.cwd();
  const factoryCtx: FactoryContext = {
    manifestDir: baseDir,
    agentName: manifest.name,
    loomVersion: LOOM_VERSION,
    clientCapabilities,
  };

  // Provider loading is the only side-effecting step. Built-in-only
  // manifests have an empty provider set; this is a no-op.
  await loadManifestProviders(resolved, factoryCtx, {}).catch(() => ({
    toolsIndex: new Map(),
    loaded: new Map(),
    loadErrors: new Map(),
  }));

  const contributions: AcpCapabilityContribution[] = [];

  // Harness contribution.
  if (resolved.harness) {
    try {
      const factory: HarnessFactory = getHarnessFactory(
        resolved.harness.factoryName,
      );
      const c = factory.acpCapabilities?.(resolved.harness.config);
      if (c) contributions.push(c);
    } catch {
      // Factory not registered (e.g., provider failed to load). Skip
      // its contribution; the agent will fail to boot at session/new
      // and the client will see the real error there.
    }
  }

  // Session contribution. A manifest without a session section falls
  // back to the default chain; absent links contribute nothing here.
  // For a multi-link chain, every link gets a chance to contribute.
  for (const link of resolved.session ?? []) {
    try {
      const factory: SessionFactory = getSessionFactory(link.factoryName);
      const c = factory.acpCapabilities?.(link.config);
      if (c) contributions.push(c);
    } catch {
      // see above
    }
  }

  // Note: tool-level capability contribution is intentionally absent.
  // Tools are resolved at boot time by providers, which the probe
  // skips. No built-in tool advertises capabilities today; if one
  // ever needs to (e.g., a tool that wants its own capability flag in
  // `_meta`), promote the contribution to the provider's Tools
  // contribution `create(config, …)` static metadata.

  return {
    agentCapabilities: aggregateAcpCapabilities(contributions),
    agentInfo: {
      name: manifest.name,
      version: LOOM_VERSION,
      ...(manifest.description ? { title: manifest.description } : {}),
    },
  };
}
