/** Best-effort extraction of an agent's last assistant message. */

import type { Session } from "../types/interfaces.js";

export async function lastAgentMessage(session: Session): Promise<string> {
  const events = (await session.pull?.([])) ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (
      e.sessionUpdate === "agent_message_chunk" &&
      e.content.type === "text"
    ) {
      return e.content.text;
    }
  }
  return "";
}
