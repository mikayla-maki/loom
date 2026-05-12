/**
 * Bare-name registries for built-in factories.
 *
 * Three registries live here, one per factory kind:
 *
 *   - **Harness** — `[harness].provider = "<name>"`
 *   - **Session** — `[session].provider = "<name>"` /
 *                  `[[session.layers]].provider = "<name>"`
 *   - **Tools (meta-factory)** — `[providers].<handle> =
 *                  { provider = "<name>", ...config }`
 *
 * The Tools registry is new in the MCP integration. It carries
 * Tools factories the runtime can instantiate **by name**, without
 * going through the on-disk provider loader. The flagship entry is
 * `mcp-server` (any MCP server, spawned + adapted), but third
 * parties may register their own before booting.
 *
 * Provider-package-contributed Tools registrations (the
 * `registerTools` from a loaded npm/path provider) are NOT in this
 * registry — those flow through `ToolsIndex` keyed by source. The
 * Tools meta-factory registry is the loader-free path: built-in or
 * SDK-registered factories that need no `package.json` round-trip.
 */

import { ResolutionError } from "../errors.js";
import type { HarnessFactory, SessionFactory } from "../types/interfaces.js";
import type { ContributionRegistration } from "../providers/loader.js";
import type { Tools } from "../types/interfaces.js";

import { anthropicHarnessFactory } from "./harness/anthropic.js";
import { openaiHarnessFactory } from "./harness/openai.js";
import { smallModelOfParentHarnessFactory } from "./harness/parent-derived.js";
import { testHarnessFactory } from "./harness/test.js";

import { compactingSessionFactory } from "./session/compacting.js";
import { fileSessionFactory } from "./session/file.js";
import { inMemorySessionFactory } from "./session/memory.js";
import { forkOfParentSessionFactory } from "./session/parent-derived.js";
import { skillsSessionFactory } from "./session/skills.js";

import { mcpServerToolsFactory } from "./provider/mcp.js";

const harnessRegistry = new Map<string, HarnessFactory>();
const sessionRegistry = new Map<string, SessionFactory>();
const toolsFactoryRegistry = new Map<string, ContributionRegistration<Tools>>();

export function registerHarness(factory: HarnessFactory): void {
  harnessRegistry.set(factory.name, factory);
}
export function registerSession(factory: SessionFactory): void {
  sessionRegistry.set(factory.name, factory);
}
/**
 * Register a Tools meta-factory by name. Built-ins (`mcp-server`)
 * register at module load; SDK consumers may call this before
 * booting to add their own.
 */
export function registerToolsFactory(
  factory: ContributionRegistration<Tools>,
): void {
  toolsFactoryRegistry.set(factory.name, factory);
}

export function getHarnessFactory(name: string): HarnessFactory {
  const f = harnessRegistry.get(name);
  if (!f) {
    throw new ResolutionError(
      `Unknown harness provider '${name}'. Registered: ${[...harnessRegistry.keys()].join(", ")}`,
    );
  }
  return f;
}
export function getSessionFactory(name: string): SessionFactory {
  const f = sessionRegistry.get(name);
  if (!f) {
    throw new ResolutionError(
      `Unknown session provider '${name}'. Registered: ${[...sessionRegistry.keys()].join(", ")}`,
    );
  }
  return f;
}
/**
 * Look up a Tools meta-factory by name. Throws with the list of
 * registered names when missing, since the only thing the resolver
 * could have written here is a name (no source to load from).
 */
export function getToolsFactory(name: string): ContributionRegistration<Tools> {
  const f = toolsFactoryRegistry.get(name);
  if (!f) {
    throw new ResolutionError(
      `Unknown built-in Tools factory '${name}'. Registered: ${[
        ...toolsFactoryRegistry.keys(),
      ].join(", ")}`,
    );
  }
  return f;
}
/** Lookup that returns `undefined` instead of throwing. */
export function findToolsFactory(
  name: string,
): ContributionRegistration<Tools> | undefined {
  return toolsFactoryRegistry.get(name);
}

export function listHarnesses(): string[] {
  return [...harnessRegistry.keys()];
}
export function listSessions(): string[] {
  return [...sessionRegistry.keys()];
}
export function listToolsFactories(): string[] {
  return [...toolsFactoryRegistry.keys()];
}

// Register built-ins.
registerHarness(testHarnessFactory);
registerHarness(anthropicHarnessFactory);
registerHarness(openaiHarnessFactory);
registerHarness(smallModelOfParentHarnessFactory);
registerSession(inMemorySessionFactory);
registerSession(fileSessionFactory);
registerSession(compactingSessionFactory);
registerSession(forkOfParentSessionFactory);
registerSession(skillsSessionFactory);
registerToolsFactory(mcpServerToolsFactory);

export {
  testHarnessFactory,
  anthropicHarnessFactory,
  openaiHarnessFactory,
  smallModelOfParentHarnessFactory,
  inMemorySessionFactory,
  fileSessionFactory,
  compactingSessionFactory,
  forkOfParentSessionFactory,
  skillsSessionFactory,
  mcpServerToolsFactory,
};
