/**
 * Parent-derived session factories.
 *
 * These run only as sub-agents — they read state from the parent's
 * `Agent` (its session in particular) and seed a fresh in-memory
 * session from it. Top-level use fails at boot via the
 * `requiresParent: true` guard in `runAgent`.
 *
 * Currently shipped:
 *   - `fork-of-parent`: copies the parent session's events into a new
 *     `MemorySession` at fork time. The child diverges from there;
 *     subsequent appends on either side don't bleed into the other.
 *     Useful for "what would the model say if we replied differently
 *     here" / branching exploration.
 */

import { MemorySession } from "./memory.js";
import { ResolutionError } from "../../errors.js";
import type {
  Agent,
  ExtensionContext,
  Session,
  SessionFactory,
} from "../../types/interfaces.js";

export const forkOfParentSessionFactory: SessionFactory = {
  name: "fork-of-parent",
  requiresParent: true,
  async create(
    _config: Record<string, unknown>,
    _ctx: ExtensionContext,
    _secrets: Record<string, string>,
    parent?: Agent,
  ): Promise<Session> {
    if (!parent) {
      throw new ResolutionError(
        "fork-of-parent session was instantiated without a parent agent",
      );
    }
    const session = new MemorySession();
    // Snapshot parent events at fork time. The child appends to its
    // own log; the parent's log is unaffected.
    const events = await parent.session.getEvents();
    for (const e of events) await session.append(e);
    return session;
  },
};
