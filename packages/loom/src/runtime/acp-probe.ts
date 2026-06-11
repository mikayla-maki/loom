import * as path from "node:path";

import { getHarnessFactory, getSessionFactory } from "../builtins/index.js";
import { parseAgentManifest } from "../manifest/parser.js";
import {
  isPreBuiltSessionLayer,
  resolveManifest,
} from "../manifest/resolver.js";
import { nativeBuiltinNames } from "../builtins/tools/native.js";
import { loadManifestProviders } from "./boot.js";
import { transientStorage } from "./storage.js";
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
    // tmpdir, not the agent's real storage, so probing doesn't create a
    // `<dataHome>/agents/<name>/` directory on every boot.
    storage: transientStorage("loom-acp-probe"),
    metadata: manifest.metadata ?? {},
  };

  await loadManifestProviders(resolved, factoryCtx, {}).catch(() => ({
    toolsIndex: new Map(),
    loaded: new Map(),
    loadErrors: new Map(),
  }));

  const contributions: AcpCapabilityContribution[] = [];

  if (resolved.harness) {
    try {
      const factory: HarnessFactory = getHarnessFactory(
        resolved.harness.factoryName,
      );
      const c = factory.acpCapabilities?.(resolved.harness.config);
      if (c) contributions.push(c);
    } catch {
      // Unregistered factory: agent will fail to boot at session/new
      // and the client sees the real error there.
    }
  }

  for (const layer of resolved.session ?? []) {
    if (isPreBuiltSessionLayer(layer)) continue;
    try {
      const factory: SessionFactory = getSessionFactory(layer.factoryName);
      const c = factory.acpCapabilities?.(layer.config);
      if (c) contributions.push(c);
    } catch {
      // see above
    }
  }

  return {
    agentCapabilities: aggregateAcpCapabilities(contributions),
    agentInfo: {
      name: manifest.name,
      version: LOOM_VERSION,
      ...(manifest.description ? { title: manifest.description } : {}),
    },
  };
}
