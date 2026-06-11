import type { CapabilitySet } from "@mcmaki/loom-capabilities";

export const ALWAYS_INHERITED_ENV = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
] as const;

export const DEFAULT_INHERITED_ENV = [
  "PATH",
  "PWD",
  "TMPDIR",
  "EDITOR",
  "VISUAL",
  "PAGER",
] as const;

export const SAFE_DEFAULT_ENV_NAMES = [
  ...ALWAYS_INHERITED_ENV,
  ...DEFAULT_INHERITED_ENV,
] as const;

// `base` is the environment the row's tier filters. It defaults to the host
// process env (normal invocations); the broker passes the host env overlaid
// with the shim's in-sandbox env, so both orchestrator-held and agent-set
// variables a row grants reach the brokered command. The tier is the same
// allowlist either way.
export function buildEnv(
  grant: CapabilitySet,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Wildcard grants are honored literally, secrets included; copy so callers
  // can't mutate the orchestrator's process.env. audit() names what's exposed.
  if (grant === "*") return { ...base };
  // execute() dispatches row sets one row at a time; a whole set falls back to
  // its first row.
  const row = Array.isArray(grant) ? (grant[0] ?? {}) : grant;
  const e = row.env;
  if (e === "*") return { ...base };
  if (e === undefined) {
    return pickEnv([...ALWAYS_INHERITED_ENV, ...DEFAULT_INHERITED_ENV], base);
  }
  if (Array.isArray(e)) {
    const requested = e.filter((n): n is string => typeof n === "string");
    return pickEnv([...ALWAYS_INHERITED_ENV, ...requested], base);
  }
  return pickEnv(ALWAYS_INHERITED_ENV, base);
}

function pickEnv(
  names: readonly string[],
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const exact: string[] = [];
  const prefixes: string[] = [];
  for (const n of names) {
    if (n.endsWith("*") && !n.slice(0, -1).includes("*")) {
      prefixes.push(n.slice(0, -1));
    } else {
      exact.push(n);
    }
  }
  const out: NodeJS.ProcessEnv = {};
  for (const name of exact) {
    const v = base[name];
    if (v !== undefined) out[name] = v;
  }
  if (prefixes.length > 0) {
    for (const [name, v] of Object.entries(base)) {
      if (v === undefined) continue;
      if (prefixes.some((p) => name.startsWith(p))) out[name] = v;
    }
  }
  return out;
}
