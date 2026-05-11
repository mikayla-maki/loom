/**
 * ACP capability aggregation. The wire shape (`AgentCapabilities`)
 * is reported once per connection at `initialize` time, so Loom
 * derives it from factory-level metadata — `HarnessFactory.acpCapabilities?(config)`
 * and `SessionFactory.acpCapabilities?(config)` — *without* booting
 * the agent. That lets `initialize` resolve before `session/new`
 * tells us the workspace cwd; the full agent boot is deferred to
 * `session/new` when the right cwd is in scope for path-grant
 * resolution.
 *
 * Aggregation rules:
 *   - `promptCapabilities.{image,audio,embeddedContext}`: OR across
 *     contributors.
 *   - `sessionCapabilities.{resume,close,fork,list}`: OR across
 *     contributors. A `{}` value in the SDK means "supported"; we
 *     mirror that.
 *   - `loadSession`: OR across contributors.
 *   - `experimental`: shallow-merged into `_meta` (later contributors win).
 */

import type {
  AgentCapabilities,
  ClientCapabilities,
  Implementation,
  PromptCapabilities,
  SessionCapabilities,
} from "@agentclientprotocol/sdk";

import type { AcpCapabilityContribution } from "../types/interfaces.js";

/**
 * Re-export of the SDK's `AgentCapabilities`. This is the wire shape
 * Loom serves in response to `initialize`.
 */
export type AgentAcpCapabilities = AgentCapabilities;

/**
 * Re-export of the SDK's `ClientCapabilities`. Loom records these on
 * each connection and reads them when deciding whether to bridge
 * permission requests, filesystem calls, etc.
 */
export type ClientAcpCapabilities = ClientCapabilities;

/** Identifying info a client sends about itself in `initialize`. */
export type ClientInfo = Implementation;

/** Identifying info Loom returns about the served agent in `initialize`. */
export type AgentInfo = Implementation;

/**
 * Default `ClientAcpCapabilities` for SDK-direct and CLI use. The
 * caller IS the client (or is so closely co-located with it that
 * there's no point negotiating), so everything is on. ACP serve
 * overrides this with whatever a real client sent in `initialize`.
 */
export const DEFAULT_CLIENT_ACP_CAPABILITIES: ClientAcpCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
};

/**
 * Compose a list of capability contributions into the SDK's
 * `AgentCapabilities` shape. Pure: no I/O, no factory lookups.
 * Contributions typically come from `probeAcpCapabilities` walking
 * the resolved manifest's factory bindings.
 */
export function aggregateAcpCapabilities(
  contributions: readonly AcpCapabilityContribution[],
): AgentAcpCapabilities {
  // Prompt capabilities: OR across contributors.
  const promptCapabilities: PromptCapabilities = {};
  let promptTouched = false;
  for (const c of contributions) {
    const p = c.promptCapabilities;
    if (!p) continue;
    promptTouched = true;
    if (p.image === true) promptCapabilities.image = true;
    if (p.audio === true) promptCapabilities.audio = true;
    if (p.embeddedContext === true) promptCapabilities.embeddedContext = true;
  }

  // Session capabilities: OR across contributors. SDK uses `{}` for
  // "supported" (per-capability sub-objects); we mirror that.
  const sessionCapabilities: SessionCapabilities = {};
  let sessionTouched = false;
  for (const c of contributions) {
    const s = c.sessionCapabilities;
    if (!s) continue;
    sessionTouched = true;
    if (s.resume) sessionCapabilities.resume = {};
    if (s.close) sessionCapabilities.close = {};
    if (s.fork) sessionCapabilities.fork = {};
    if (s.list) sessionCapabilities.list = {};
  }

  // loadSession: OR across contributors.
  let loadSession = false;
  for (const c of contributions) {
    if (c.loadSession === true) loadSession = true;
  }

  // Experimental: shallow merge (later wins).
  const experimental: Record<string, unknown> = {};
  for (const c of contributions) {
    Object.assign(experimental, c.experimental ?? {});
  }

  const out: AgentAcpCapabilities = {};
  if (promptTouched) out.promptCapabilities = promptCapabilities;
  if (sessionTouched) out.sessionCapabilities = sessionCapabilities;
  if (loadSession) out.loadSession = true;
  if (Object.keys(experimental).length > 0) {
    out._meta = experimental;
  }
  return out;
}
