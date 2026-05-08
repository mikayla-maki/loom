/**
 * Loom — public entry.
 */

export * from "./types/index.js";
export * from "./sdk/index.js";
export * as errors from "./errors.js";

export { resolveSystemPrompt } from "./manifest/resolver.js";

export { parseAgentManifest, parseSkillManifest } from "./manifest/parser.js";

export {
  assertCapabilities,
  defaultContains,
} from "./manifest/capabilities.js";

export {
  registerHarness,
  registerSession,
  getHarnessFactory,
  getSessionFactory,
  listHarnesses,
  listSessions,
  testHarnessFactory,
  anthropicHarnessFactory,
  openaiHarnessFactory,
  memorySessionFactory,
  fileSessionFactory,
  compactingSessionFactory,
} from "./extensions/index.js";

export {
  CompactingSession,
  heuristicCompactor,
  modelCompactor,
  adjustForToolPairs,
} from "./extensions/session/compacting.js";
export type {
  Compactor,
  CompactingSessionOptions,
  ModelCompactorOptions,
} from "./extensions/session/compacting.js";

export { summarise, summariseViaRun } from "./sdk/session-utils.js";

export type {
  TestHarnessConfig,
  TurnScript,
  TurnStep,
} from "./extensions/harness/test.js";

// Concrete harness classes — useful when an SDK consumer wants to wire
// the harness instance themselves rather than going through the
// `{ provider: "anthropic", … }` factory form.
export { AnthropicHarness } from "./extensions/harness/anthropic.js";
export { TestHarness } from "./extensions/harness/test.js";
export { OpenAIHarness } from "./extensions/harness/openai.js";

export {
  loadExtensionPackage,
  locateExtensionPackage,
  listInstalledExtensions,
} from "./extensions/loader.js";
export type {
  LoomExtensionApi,
  LoomExtensionModule,
  ExtensionPackageInfo,
  LoadOptions as ExtensionLoadOptions,
} from "./extensions/loader.js";

export {
  nativeProviderFactory,
  buildNativeProvider,
} from "./extensions/provider/native.js";

export { auditAgent, formatCapabilityTree } from "./audit/audit.js";
export type { CapabilityTree } from "./audit/audit.js";

export { LocalRegistry } from "./registry/registry.js";
export type { RegistryOptions } from "./registry/registry.js";

export {
  EnvSecretsStore,
  FileSecretsStore,
  XDGSecretsStore,
  KeychainSecretsStore,
  StaticSecretsStore,
  ChainedSecretsStore,
  resolveSecrets,
} from "./runtime/secrets.js";
export type { SecretsStore } from "./runtime/secrets.js";
