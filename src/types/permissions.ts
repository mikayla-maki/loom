/**
 * Permission system — runtime-mediated user-consent channel.
 *
 * Some tools want to ask the user before taking a sensitive action. The
 * canonical example is `add_skill` (now removed) wanting to expand the
 * agent's `[sandbox]` ceiling, but the same channel applies to any tool
 * that wants a "are you sure?" rail — destructive operations, network
 * calls outside a normal envelope, etc.
 *
 * The hatch is a `PermissionHandler` registered by the SDK consumer (CLI,
 * ACP client, embedder). When a tool wants user consent, it calls through
 * `Runtime.requestPermission`, the runtime invokes the handler, and the
 * tool acts on the returned `PermissionDecision`. If no handler is
 * registered, the runtime denies — the secure default.
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
export const denyAllPermissionHandler: PermissionHandler = () => ({
  decision: "deny",
});

/** Convenience: a handler that allows everything (test/embedded contexts). */
export const allowAllPermissionHandler: PermissionHandler = () => ({
  decision: "allow_session",
});
