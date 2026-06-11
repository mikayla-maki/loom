import type { Capabilities, CapabilitySet } from "./types.js";

export const DEFAULT_TOP_LEVEL_CAPABILITIES = {
  bash: { commands: "*", paths: ["./"] },
  read_file: { paths: ["./"] },
  write_file: { paths: ["./"] },
  edit_file: { paths: ["./"] },
} as const satisfies Record<string, CapabilitySet>;

// The ceiling: the agent's total authority surface. An explicit
// [capabilities] section is the ceiling verbatim; absent one, the
// conservative default applies. Never fails open.
export function ceilingFor(manifest: {
  capabilities?: Capabilities;
}): Capabilities {
  return manifest.capabilities ?? { ...DEFAULT_TOP_LEVEL_CAPABILITIES };
}
