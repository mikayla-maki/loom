import { InMemorySession } from "./memory.js";
import { ResolutionError } from "../../errors.js";
import type {
  Agent,
  FactoryContext,
  Session,
  SessionFactory,
} from "../../types/interfaces.js";

export const forkOfParentSessionFactory: SessionFactory = {
  name: "fork-of-parent",
  requiresParent: true,
  async create(
    _config: Record<string, unknown>,
    _ctx: FactoryContext,
    _secrets: Record<string, string>,
    parent?: Agent,
  ): Promise<Session> {
    if (!parent) {
      throw new ResolutionError(
        "fork-of-parent session was instantiated without a parent agent",
      );
    }
    const session = new InMemorySession();
    const events = (await parent.session.pull?.([])) ?? [];
    for (const e of events) await session.push(e);
    return session;
  },
};
