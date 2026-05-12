/**
 * Bare-name registry for harness and session factories. Built-ins are
 * registered at the bottom; third parties may call `registerHarness` /
 * `registerSession` before booting. Tool/skill providers are NOT here —
 * they're contributed by the native provider plus `[extensions]` entries
 * loaded dynamically by `runAgent`.
 */

import { ResolutionError } from "../errors.js";
import type { HarnessFactory, SessionFactory } from "../types/interfaces.js";

import { anthropicHarnessFactory } from "./harness/anthropic.js";
import { openaiHarnessFactory } from "./harness/openai.js";
import { smallModelOfParentHarnessFactory } from "./harness/parent-derived.js";
import { testHarnessFactory } from "./harness/test.js";

import { compactingSessionFactory } from "./session/compacting.js";
import { fileSessionFactory } from "./session/file.js";
import { inMemorySessionFactory } from "./session/memory.js";
import { forkOfParentSessionFactory } from "./session/parent-derived.js";
import { skillsSessionFactory } from "./session/skills.js";

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
registerSession(inMemorySessionFactory);
registerSession(fileSessionFactory);
registerSession(compactingSessionFactory);
registerSession(forkOfParentSessionFactory);
registerSession(skillsSessionFactory);

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
};
