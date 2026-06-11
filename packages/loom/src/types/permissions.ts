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

export type PermissionHandler = (
  req: Omit<RequestPermissionRequest, "sessionId">,
) => Promise<RequestPermissionResponse> | RequestPermissionResponse;

export const denyAllPermissionHandler: PermissionHandler = () => ({
  outcome: { outcome: "cancelled" },
});

export const allowAllPermissionHandler: PermissionHandler = (req) => {
  const first = req.options[0];
  if (!first) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: first.optionId } };
};
