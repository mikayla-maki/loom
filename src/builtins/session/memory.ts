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
