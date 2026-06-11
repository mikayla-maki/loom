import type {
  AgentCapabilities,
  ClientCapabilities,
  Implementation,
  PromptCapabilities,
  SessionCapabilities,
} from "@agentclientprotocol/sdk";

import type { AcpCapabilityContribution } from "../types/interfaces.js";

export type AgentAcpCapabilities = AgentCapabilities;

export type ClientAcpCapabilities = ClientCapabilities;

export type ClientInfo = Implementation;

export type AgentInfo = Implementation;

export const DEFAULT_CLIENT_ACP_CAPABILITIES: ClientAcpCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
};

export function aggregateAcpCapabilities(
  contributions: readonly AcpCapabilityContribution[],
): AgentAcpCapabilities {
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

  // SDK uses `{}` to mean "supported".
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

  let loadSession = false;
  for (const c of contributions) {
    if (c.loadSession === true) loadSession = true;
  }

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
