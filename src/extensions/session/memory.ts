/**
 * In-memory session — push events into an array, return them on pull.
 * Goes away when the process exits.
 *
 * Leaf session in the new push/pull model: stores events on push,
 * returns them on pull (ignoring the `below` argument because as a
 * leaf it produces from its own state, not from anything below).
 */

import type {
  ExtensionContext,
  Session,
  SessionFactory,
} from "../../types/interfaces.js";
import type { SessionUpdate } from "../../types/acp.js";

export class MemorySession implements Session {
  private events: SessionUpdate[] = [];

  async push(update: SessionUpdate): Promise<SessionUpdate[]> {
    this.events.push(update);
    return [update];
  }

  async pull(_below: SessionUpdate[]): Promise<SessionUpdate[]> {
    // Leaf: produce from internal state. `below` is empty for leaves.
    return [...this.events];
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
