import type { PermissionOption } from "../types/permissions.js";

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

export function isAllowOutcome(optionId: string): boolean {
  return optionId.startsWith("allow_");
}
