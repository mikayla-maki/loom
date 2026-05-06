/**
 * In-memory session — used by tests and the test harness. Stores updates in
 * an array; goes away when the process exits.
 *
 * Optional config:
 *   contributesSkills: SkillManifest[] — for testing the
 *     session-contributes-skills feature.
 */

import type {
  ExtensionContext,
  Session,
  SessionFactory,
} from "../../types/interfaces.js";
import type { SessionUpdate } from "../../types/acp.js";
import type { SkillManifest } from "../../types/manifest.js";

export class MemorySession implements Session {
  private events: SessionUpdate[] = [];
  constructor(private readonly contributedSkills: SkillManifest[] = []) {}

  async append(update: SessionUpdate): Promise<void> {
    this.events.push(update);
  }
  async getEvents(from = 0, to?: number): Promise<SessionUpdate[]> {
    return this.events.slice(from, to);
  }
  async count(): Promise<number> {
    return this.events.length;
  }
  skills(): SkillManifest[] {
    return this.contributedSkills;
  }
}

export const memorySessionFactory: SessionFactory = {
  name: "memory",
  create(config: Record<string, unknown>, _ctx: ExtensionContext, _secrets: Record<string, string>): Session {
    const skills = (config.contributesSkills as SkillManifest[] | undefined) ?? [];
    return new MemorySession(skills);
  },
};
