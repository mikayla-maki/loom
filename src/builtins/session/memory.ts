/** In-memory session — leaf store; events live until the process exits. */

import type {
  FactoryContext,
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
    return [...this.events];
  }
}

export const memorySessionFactory: SessionFactory = {
  name: "memory",
  create(
    _config: Record<string, unknown>,
    _ctx: FactoryContext,
    _secrets: Record<string, string>,
  ): Session {
    return new MemorySession();
  },
};
