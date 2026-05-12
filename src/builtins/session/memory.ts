/**
 * `in-memory` session — the canonical leaf storage layer.
 *
 * Events live in a process-local array; nothing is persisted. The
 * session has no config — every instance is a fresh, empty log. When
 * the process exits, the conversation is gone. Use a `file`-backed
 * session below the compacting layer if you want durability.
 *
 * Named "in-memory" rather than "memory" to disambiguate from the
 * broader concept of "the agent's memory" (which is the whole
 * session chain, not just the storage layer).
 */

import type {
  FactoryContext,
  Session,
  SessionFactory,
} from "../../types/interfaces.js";
import type { SessionUpdate } from "../../types/acp.js";

export class InMemorySession implements Session {
  private events: SessionUpdate[] = [];

  async push(update: SessionUpdate): Promise<SessionUpdate[]> {
    this.events.push(update);
    return [update];
  }

  async pull(_below: SessionUpdate[]): Promise<SessionUpdate[]> {
    return [...this.events];
  }
}

export const inMemorySessionFactory: SessionFactory = {
  name: "in-memory",
  create(
    _config: Record<string, unknown>,
    _ctx: FactoryContext,
    _secrets: Record<string, string>,
  ): Session {
    return new InMemorySession();
  },
};
