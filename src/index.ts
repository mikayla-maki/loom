/**
 * Loom — public entry.
 */

export * from "./types/index.js";
export * from "./sdk/index.js";
export * as errors from "./errors.js";

export { resolveSystemPrompt } from "./manifest/resolver.js";

export { parseAgentManifest } from "./manifest/parser.js";

export {
  assertKnownKinds,
  assertRequires,
  assertSecretAllowlist,
  defaultContains,
  grantFor,
  isStarSet,
  kindGranted,
  valueFor,
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
  smallModelOfParentHarnessFactory,
  inMemorySessionFactory,
  fileSessionFactory,
  compactingSessionFactory,
  forkOfParentSessionFactory,
  skillsSessionFactory,
} from "./builtins/index.js";

export {
  CompactingSession,
  compactingMemorySession,
  compactingFileSession,
  heuristicCompactor,
  modelCompactor,
  adjustForToolPairs,
} from "./builtins/session/compacting.js";
export { InMemorySession } from "./builtins/session/memory.js";
export { FileSession } from "./builtins/session/file.js";
export { SkillsSession } from "./builtins/session/skills.js";
export { ChainedSession } from "./runtime/session-chain.js";
export type {
  ClientBridge,
  CreateTerminalParams,
} from "./runtime/client-bridge.js";
export { raceAbort } from "./runtime/client-bridge.js";
export type {
  Compactor,
  CompactingSessionOptions,
  ModelCompactorOptions,
} from "./builtins/session/compacting.js";
export type {
  Skill,
  SkillFrontmatter,
  SkillsSessionOptions,
} from "./builtins/session/skills.js";

export { summarise, summariseViaRun } from "./sdk/session-utils.js";

export type {
  TestHarnessConfig,
  TurnScript,
  TurnStep,
} from "./builtins/harness/test.js";

// Concrete harness classes — useful when an SDK consumer wants to wire
// the harness instance themselves rather than going through the
// `{ provider = "anthropic", … }` factory form.
export { AnthropicHarness } from "./builtins/harness/anthropic.js";
export { TestHarness } from "./builtins/harness/test.js";
export { OpenAIHarness } from "./builtins/harness/openai.js";

export {
  loadProviderByName,
  loadProviderFromPath,
  loadProviderFromSource,
  locateProviderPackage,
  listInstalledProviders,
} from "./providers/loader.js";
export type {
  ContributionRegistration,
  LoomProviderApi,
  LoomProviderModule,
  ProviderPackageInfo,
  LoadedProvider,
  LoadOptions as ProviderLoadOptions,
} from "./providers/loader.js";

export { buildNativeTools } from "./builtins/tools/native.js";

export { auditAgent, formatCapabilityTree } from "./audit/audit.js";
export type { CapabilityTree } from "./audit/audit.js";

export {
  EnvSecretsStore,
  FileSecretsStore,
  XDGSecretsStore,
  KeychainSecretsStore,
  StaticSecretsStore,
  ChainedSecretsStore,
} from "./runtime/secrets.js";
export type { SecretsStore } from "./runtime/secrets.js";
