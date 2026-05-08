/**
 * Extension registry — bare-name resolution of harness/session factories.
 *
 * Built-in extensions are registered here. Third-party extensions can call
 * `registerHarness` / `registerSession` from app code before booting an
 * agent. (Future: dynamic loading from `~/.loom/extensions`.)
 *
 * Tool/skill providers are NOT in this registry — they're contributed
 * by the native provider (always loaded) plus any
 * `[extensions].<pkg>` entries in the manifest, which `runAgent` loads
 * dynamically and instantiates via their `ProviderFactory`. The
 * `Provider` interface lives in `types/interfaces.ts`.
 */

import { ResolutionError } from "../errors.js";
import type { HarnessFactory, SessionFactory } from "../types/interfaces.js";

import { anthropicHarnessFactory } from "./harness/anthropic.js";
import { openaiHarnessFactory } from "./harness/openai.js";
import { smallModelOfParentHarnessFactory } from "./harness/parent-derived.js";
import { testHarnessFactory } from "./harness/test.js";

import { compactingSessionFactory } from "./session/compacting.js";
import { fileSessionFactory } from "./session/file.js";
import { memorySessionFactory } from "./session/memory.js";
import { forkOfParentSessionFactory } from "./session/parent-derived.js";

const harnessRegistry = new Map<string, HarnessFactory>();
const sessionRegistry = new Map<string, SessionFactory>();

export function registerHarness(factory: HarnessFactory): void {
  harnessRegistry.set(factory.name, factory);
}
export function registerSession(factory: SessionFactory): void {
  sessionRegistry.set(factory.name, factory);
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

export function listHarnesses(): string[] {
  return [...harnessRegistry.keys()];
}
export function listSessions(): string[] {
  return [...sessionRegistry.keys()];
}

// Register built-ins.
registerHarness(testHarnessFactory);
registerHarness(anthropicHarnessFactory);
registerHarness(openaiHarnessFactory);
registerHarness(smallModelOfParentHarnessFactory);
registerSession(memorySessionFactory);
registerSession(fileSessionFactory);
registerSession(compactingSessionFactory);
registerSession(forkOfParentSessionFactory);

export {
  testHarnessFactory,
  anthropicHarnessFactory,
  openaiHarnessFactory,
  smallModelOfParentHarnessFactory,
  memorySessionFactory,
  fileSessionFactory,
  compactingSessionFactory,
  forkOfParentSessionFactory,
};
