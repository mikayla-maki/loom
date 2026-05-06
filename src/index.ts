/**
 * Loom — public entry.
 */

export * from "./types/index.js";
export * from "./sdk/index.js";
export * as errors from "./errors.js";

export { resolveAgent } from "./manifest/resolver.js";
export type {
  ResolveOptions,
  ResolvedAgentManifest,
  ResolvedSkill,
  ResolvedTool,
  ResolvedSubagent,
} from "./manifest/resolver.js";

export {
  parseAgentManifest,
  parseSkillManifest,
  parseToolManifest,
  parseSubagentsFile,
} from "./manifest/parser.js";

export { unionCapabilities, assertSubset } from "./manifest/capabilities.js";

export {
  registerHarness,
  registerSession,
  registerProvider,
  getHarnessFactory,
  getSessionFactory,
  getProviderFactory,
  listHarnesses,
  listSessions,
  listProviders,
  testHarnessFactory,
  anthropicHarnessFactory,
  openaiHarnessFactory,
  memorySessionFactory,
  fileSessionFactory,
} from "./extensions/index.js";

export type {
  TestHarnessConfig,
  TurnScript,
  TurnStep,
} from "./extensions/harness/test.js";

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
