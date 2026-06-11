import type { CapabilityGrant } from "../../types/manifest.js";
import { buildEnv } from "../builtins/bash.js";
import { maybeBwrapPrefix } from "./bwrap.js";
import { maybeSandboxExecPrefix, sandboxEngaged } from "./sandbox-exec.js";

// Bash resolves exactly one grant row before any sandbox is constructed.
export type SingleRowGrant = "*" | CapabilityGrant;

export interface SandboxPrefix {
  binary: string;
  prefixArgs: string[];
}

export interface SandboxPlan {
  /** Spawn this instead of the command, with `prefixArgs` ahead of it. */
  prefix: SandboxPrefix | null;
  /** Whether the grant asks for confinement (anything other than `"*"`). */
  engaged: boolean;
  /**
   * True when the grant is structured but no platform sandbox is available.
   * Callers that want a fail-closed posture should refuse to run.
   */
  unavailable: boolean;
  /** Environment a sandboxed command should run with (deny-by-default). */
  env: NodeJS.ProcessEnv;
}

/**
 * Resolve the single-grant bash sandbox for the host platform, without the
 * command broker. This is the embeddable confinement primitive: pass it a
 * resolved grant row and it returns a spawn prefix (sandbox-exec on macOS,
 * bwrap on Linux) plus the deny-by-default environment that grant implies.
 *
 * It does NOT set up per-command escalation (the broker). A `"*"` grant is a
 * no-op (`prefix: null`, `engaged: false`). A structured grant on a platform
 * with no sandbox returns `unavailable: true` so the caller can fail closed.
 */
export async function bashSandboxPlan(
  grant: SingleRowGrant,
  base: NodeJS.ProcessEnv = process.env,
): Promise<SandboxPlan> {
  const env = buildEnv(grant, base);
  if (!sandboxEngaged(grant)) {
    return { prefix: null, engaged: false, unavailable: false, env };
  }
  let prefix: SandboxPrefix | null = null;
  if (process.platform === "darwin") {
    prefix = await maybeSandboxExecPrefix(grant);
  } else if (process.platform === "linux") {
    prefix = await maybeBwrapPrefix(grant);
  }
  return { prefix, engaged: true, unavailable: prefix === null, env };
}
