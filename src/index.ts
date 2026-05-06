/**
 * Glass — public entry.
 */

export * from "./types/index.js";
export * from "./sdk/index.js";
export * as errors from "./errors.js";

export { resolveAgent } from "./manifest/resolver.js";
export type { ResolveOptions, ResolvedAgent, ResolvedSkill, ResolvedTool } from "./manifest/resolver.js";

export {
  parseAgentManifest,
  parseSkillManifest,
  parseToolManifest,
  parseSubagentsFile,
} from "./manifest/parser.js";

export {
  unionCapabilities,
  assertSubset,
} from "./manifest/capabilities.js";

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

export type { TestHarnessConfig, TurnScript, TurnStep } from "./extensions/harness/test.js";

export { auditAgent } from "./audit/audit.js";
export type { CapabilityTree } from "./audit/audit.js";
