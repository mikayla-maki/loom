/**
 * In-memory session — used by tests and the test harness. Stores updates in
 * an array; goes away when the process exits.
 */

import type {
  ExtensionContext,
  Session,
  SessionFactory,
} from "../../types/interfaces.js";
import type { SessionUpdate } from "../../types/acp.js";

export class MemorySession implements Session {
  private events: SessionUpdate[] = [];

  async append(update: SessionUpdate): Promise<void> {
    this.events.push(update);
  }
  async getEvents(from = 0, to?: number): Promise<SessionUpdate[]> {
    return this.events.slice(from, to);
  }
  async count(): Promise<number> {
    return this.events.length;
  }
}

export const memorySessionFactory: SessionFactory = {
  name: "memory",
  create(
    _config: Record<string, unknown>,
    _ctx: ExtensionContext,
    _secrets: Record<string, string>,
  ): Session {
    return new MemorySession();
  },
};
