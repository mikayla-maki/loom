/**
 * Permission system — runtime-mediated user-consent channel.
 *
 * Wire types are re-exported from `@agentclientprotocol/sdk` so that
 * Loom's tool-permission API matches ACP's `session/request_permission`
 * byte-for-byte. Tools call `ctx.requestPermission(req)` where `req`
 * is a `RequestPermissionRequest` minus `sessionId` (filled by the
 * runtime); the response is a `RequestPermissionResponse`.
 *
 * If no handler is registered, the runtime synthesises a "cancelled"
 * outcome — the secure default.
 */

export type {
  PermissionOption,
  PermissionOptionId,
  PermissionOptionKind,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SelectedPermissionOutcome,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";

import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

/**
 * The runtime-facing handler signature. Tools call
 * `ctx.requestPermission(req)` with a `RequestPermissionRequest`
 * minus `sessionId` (the runtime/ACP layer injects that when bridging
 * to the wire). The handler responds with a full
 * `RequestPermissionResponse`.
 */
export type PermissionHandler = (
  req: Omit<RequestPermissionRequest, "sessionId">,
) => Promise<RequestPermissionResponse> | RequestPermissionResponse;

/** Convenience: a handler that cancels every request (the secure default). */
export const denyAllPermissionHandler: PermissionHandler = () => ({
  outcome: { outcome: "cancelled" },
});

/** Convenience: a handler that always selects the first option. */
export const allowAllPermissionHandler: PermissionHandler = (req) => {
  const first = req.options[0];
  if (!first) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: first.optionId } };
};
