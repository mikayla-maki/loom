/**
 * Permission helpers — small reusable bits for tools that ask the
 * user for consent via `ctx.requestPermission`.
 *
 * The runtime-mediated channel maps onto ACP's
 * `session/request_permission` directly; this module just provides
 * convenience for tools that don't want to roll their own option set.
 */

import type { PermissionOption } from "../types/permissions.js";

/**
 * The standard four-option set most tools want. Tools wanting a
 * custom set construct their own `PermissionOption[]` and pass it to
 * `ctx.requestPermission({ toolCall, options })`.
 */
export function standardPermissionOptions(): PermissionOption[] {
  return [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    {
      optionId: "reject_always",
      name: "Always reject",
      kind: "reject_always",
    },
  ];
}

/**
 * Convenience predicate: returns true when the outcome the user
 * selected has an `optionId` whose kind starts with `allow_*`. Useful
 * for tools that just want a boolean allow/deny.
 */
export function isAllowOutcome(optionId: string): boolean {
  return optionId.startsWith("allow_");
}
