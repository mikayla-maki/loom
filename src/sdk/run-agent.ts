/**
 * runAgent — the top-level SDK entry point.
 *
 * Resolves a manifest, loads extensions, walks the skill→tool graph, fetches
 * secrets, validates capabilities, sets up PATH for tool binaries, instantiates
 * the session and harness, and returns a RunningAgent SDK handle. Does NOT
 * run a turn — the client triggers turns via prompt().
 */

import * as path from "node:path";

import { getHarnessFactory, getSessionFactory } from "../extensions/index.js";
import { resolveAgent, type ResolveOptions, type ResolvedAgent } from "../manifest/resolver.js";
import { RuntimeImpl } from "../runtime/runtime.js";
import { ProcessTool, ToolTable } from "../runtime/tool-table.js";
import { UpdateSink } from "../runtime/update-sink.js";
import {
  ChainedSecretsStore,
  EnvSecretsStore,
  FileSecretsStore,
  resolveSecrets,
  StaticSecretsStore,
  type SecretsStore,
} from "../runtime/secrets.js";
import type { ExtensionContext, Session, SessionFactory, Tool } from "../types/interfaces.js";
import type { SkillManifest } from "../types/manifest.js";

import { RunningAgentImpl, type RunningAgent } from "./running-agent.js";

export const GLASS_VERSION = "0.1.0";

export interface RunAgentOptions {
  /** Resolver options (registry, custom builtins). */
  resolve?: ResolveOptions;
  /** Custom secrets store. Defaults to env + optional secrets file in manifest dir. */
  secrets?: SecretsStore;
  /** If a secret is missing, omit it from the env rather than throwing. */
  allowMissingSecrets?: boolean;
  /** Override the agent's session provider (e.g. tests want memory). */
  sessionOverride?: SessionFactory;
  /** Override the agent's harness provider (e.g. tests want test). */
  harnessOverride?: { factory: import("../types/interfaces.js").HarnessFactory; config?: Record<string, unknown> };
  /** Override the harness config inline (without changing the factory). */
  harnessConfigOverride?: Record<string, unknown>;
  /** Override the session config inline (without changing the factory). */
  sessionConfigOverride?: Record<string, unknown>;
  /** For testing: deterministic 'now' used in system-prompt assembly. */
  now?: () => Date;
  /** Per-tool execution timeout in ms (passed through to ProcessTool). */
  toolTimeoutMs?: number;
}

export async function runAgent(
  manifestPath: string,
  options: RunAgentOptions = {},
): Promise<RunningAgent> {
  const resolved = await resolveAgent(manifestPath, options.resolve ?? {});

  // Secrets store (chained: explicit > env > optional file in manifest dir).
  const stores: SecretsStore[] = [];
  if (options.secrets) stores.push(options.secrets);
  stores.push(new EnvSecretsStore());
  const manifestDir = path.dirname(resolved.manifest.manifestPath);
  stores.push(new FileSecretsStore(path.join(manifestDir, ".glass-secrets")));
  const store = new ChainedSecretsStore(stores);

  // Load every secret named in the agent's [sandbox] ceiling. Tool-required
  // secrets must be present (or `allowMissingSecrets` is set); ceiling-only
  // secrets that aren't strictly required are loaded best-effort (so the
  // builtin `secrets.get` can hand them to the model on demand).
  const requiredSecretNames = Array.from(resolved.requiredSecrets.keys());
  const ceilingSecretNames = resolved.manifest.sandbox.secrets ?? [];
  const ceilingOnly = ceilingSecretNames.filter((n) => !resolved.requiredSecrets.has(n));

  const required = await resolveSecrets(store, requiredSecretNames, {
    allowMissing: options.allowMissingSecrets ?? false,
  });
  const optional = await resolveSecrets(store, ceilingOnly, { allowMissing: true });
  const secrets: Record<string, string> = { ...required, ...optional };

  // Tools (process-backed).
  const tools: Tool[] = resolved.tools.map(
    (rt) =>
      new ProcessTool(rt.manifest, {
        extraPath: resolved.pathAdditions,
        ...(options.toolTimeoutMs ? { timeoutMs: options.toolTimeoutMs } : {}),
      }),
  );
  const toolTable = new ToolTable(tools, secrets);

  // Extensions: factories.
  const ctx: ExtensionContext = {
    manifestDir,
    agentName: resolved.manifest.agent.name,
    glassVersion: GLASS_VERSION,
  };

  const sessionFactory = options.sessionOverride
    ? options.sessionOverride
    : getSessionFactory(resolved.manifest.session.provider);
  const sessionConfig: Record<string, unknown> = {
    ...resolved.manifest.session,
    ...(options.sessionConfigOverride ?? {}),
  };
  delete sessionConfig.provider;
  const session = await sessionFactory.create(sessionConfig, ctx);

  const harnessFactory = options.harnessOverride
    ? options.harnessOverride.factory
    : getHarnessFactory(resolved.manifest.harness.provider);
  const harnessConfig: Record<string, unknown> = options.harnessOverride?.config
    ? options.harnessOverride.config
    : { ...resolved.manifest.harness, ...(options.harnessConfigOverride ?? {}) };
  delete harnessConfig.provider;
  const harness = await harnessFactory.create(harnessConfig, ctx);

  // Merge skills (manifest + session-contributed).
  const sessionSkills = await collectSessionSkills(session);
  const allSkills: SkillManifest[] = [
    ...resolved.skills.map((s) => s.manifest),
    ...sessionSkills,
  ];

  const updateSink = new UpdateSink();

  return new RunningAgentImpl({
    resolved,
    secrets,
    session,
    harness,
    toolTable,
    skills: allSkills,
    updateSink,
    ...(options.now ? { now: options.now } : {}),
  });
}

async function collectSessionSkills(session: Session): Promise<SkillManifest[]> {
  if (!session.skills) return [];
  const result = session.skills();
  return Array.isArray(result) ? result : await result;
}

// Re-export commonly used helpers
export { RuntimeImpl, UpdateSink, StaticSecretsStore };
