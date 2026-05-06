/**
 * Permission system — runtime-mediated capability expansion.
 *
 * Some operations (most notably `add_skill`) want to expand an agent's
 * declared `[sandbox]` ceiling at runtime. That breaks the static
 * "every scope sandboxed; tools punch out" model unless we add a
 * deliberate, user-mediated escape hatch.
 *
 * The hatch is a `PermissionHandler` registered by the SDK consumer (CLI,
 * ACP client, embedder). When the runtime needs more capability than the
 * agent's current ceiling permits, it builds a `PermissionRequest`, calls
 * the handler, and acts on the returned `PermissionDecision`. If no handler
 * is registered, the runtime fails closed — same end-state as today.
 *
 * ACP carries the same shape as `session/request_permission` notifications
 * to the connected client.
 */

import type { Capabilities } from "./manifest.js";

/** Discrete user choices — mirrors ACP `RequestPermissionOutcome`. */
export type PermissionDecision = "allow_once" | "allow_session" | "deny";

export interface PermissionRequest {
  /** Stable key so handlers can route on intent. */
  kind: "expand_sandbox" | string;
  /** Human-readable summary the handler can show to the user. */
  reason: string;
  /**
   * Capabilities being requested. For `expand_sandbox`, this is the *diff*
   * — the set of capabilities NOT already in the current ceiling.
   */
  newCapabilities?: Capabilities;
  /** Snapshot of the current ceiling, for context. */
  currentCeiling?: Capabilities;
  /** Free-form metadata (skill name, tool name, etc.). */
  metadata?: Record<string, unknown>;
}

export interface PermissionResult {
  decision: PermissionDecision;
}

export type PermissionHandler = (
  req: PermissionRequest,
) => Promise<PermissionResult> | PermissionResult;

/** Convenience: a handler that denies everything (the secure default). */
export const denyAllPermissionHandler: PermissionHandler = () => ({ decision: "deny" });

/** Convenience: a handler that allows everything (test/embedded contexts). */
export const allowAllPermissionHandler: PermissionHandler = () => ({ decision: "allow_session" });
