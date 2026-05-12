/**
 * `bash` — execute a shell command via `/bin/bash -c`.
 *
 * Capability kinds:
 *   requires: ["subprocess"]
 *   optional: ["paths", "network", "env"]
 *
 * The grant determines what the bash subprocess can reach. The
 * description and (in a follow-up commit) the OS-level sandbox profile
 * are both derived from this grant — the same JSON drives the model's
 * mental model, the runtime self-policing, and (eventually) the
 * sandbox-exec rules. One source of truth.
 *
 * macOS sandbox engagement: when the grant is structured (anything
 * other than `"*"`), bash spawns under `/usr/bin/sandbox-exec` with
 * a generated SBPL profile derived from the grant. `"*"` opts out
 * (no sandbox). On Linux a sandbox engagement is a no-op for now (we
 * surface a warning at audit time); a `bwrap`-based path can slot
 * into the same shape later. The `env` filter applies regardless of
 * sandbox availability.
 *
 * Env semantics (asymmetric with paths/network on purpose — see below):
 *
 * The env is built from two tiers, both drawn from `process.env`:
 *
 *   - **Tier 1 — ALWAYS_INHERITED_ENV.** Identity + terminal + locale
 *     plumbing (HOME, USER, LANG, TERM, TZ, …). Always present in the
 *     child env regardless of grant. Even `env = []` keeps these —
 *     a hermetic shell with broken locale and no `$HOME` isn't
 *     hermetic, it's broken. None of these names can redirect what
 *     code executes.
 *   - **Tier 2 — DEFAULT_INHERITED_ENV.** Useful-but-overrideable
 *     defaults (PATH, PWD, TMPDIR, EDITOR, VISUAL, PAGER). Included
 *     when the grant doesn't specify `env`; dropped when `env` is
 *     an explicit list. Users who want to substitute their own PATH
 *     write `env = ["PATH"]` (or set PATH inside the bash command).
 *
 * Full grant table:
 *
 *   env absent          → Tier 1 + Tier 2 (the typical convenient case).
 *   env = "*"           → process.env passed through unfiltered.
 *   env = []            → Tier 1 only (hermetic-but-functional shell).
 *   env = ["NAME"]      → Tier 1 + exact name from process.env.
 *   env = ["AWS_*"]     → Tier 1 + prefix match — every name starting
 *                         with `AWS_`. Trailing `*` only; no other
 *                         glob metacharacters. Mixable with exact:
 *                         `env = ["AWS_*", "PATH"]`.
 *
 * The asymmetry: absent = denied is the right default for `paths` and
 * `network` (less access is safer). For `env`, absent = nothing would
 * break command resolution entirely, which would push users toward
 * `"*"` (full leak). Smart defaults is the actually-safe middle, and
 * Tier 1's always-on guarantee means an explicit list never
 * accidentally strips terminal sanity.
 */

import { spawn } from "node:child_process";

import type {
  AuditFinding,
  Tool,
  ToolConfig,
  ToolContext,
  ToolResult,
} from "../../types/interfaces.js";
import type { CapabilitySet } from "../../types/manifest.js";
import type { JSONSchema } from "../../types/schema.js";

import {
  hasBwrap,
  maybeBwrapPrefix,
  validateBashGrantLinux,
} from "../sandbox/bwrap.js";
import {
  hasSandboxExec,
  maybeSandboxExecPrefix,
  sandboxEngaged,
  validateBashGrant,
} from "../sandbox/sandbox-exec.js";
import { describePaths, paths, resolvedPaths } from "./_path.js";

/**
 * Always passed through to bash, regardless of the `env` capability.
 * Identity, terminal, and locale plumbing — you cannot run a sane
 * shell without these and none of them can redirect what code
 * executes (no PATH-like effects, no preload-attack vectors).
 */
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

/**
 * Passed through when `env` is absent from the grant. Replaced (not
 * extended) when `env` is an explicit list — if you write `env = []`
 * you get only Tier 1; if you write `env = ["FOO"]` you get Tier 1
 * + FOO. These are useful-by-default but plausibly overrideable: PATH
 * controls command resolution, TMPDIR controls temp-file location,
 * EDITOR/VISUAL/PAGER influence which program a tool spawns when it
 * wants to defer to user preference.
 */
export const DEFAULT_INHERITED_ENV = [
  "PATH",
  "PWD",
  "TMPDIR",
  "EDITOR",
  "VISUAL",
  "PAGER",
] as const;

/**
 * Union of Tier 1 + Tier 2 — what `env`-absent gets. Exported for
 * audit / description rendering so docs and the help text stay in
 * lockstep with the code.
 */
export const SAFE_DEFAULT_ENV_NAMES = [
  ...ALWAYS_INHERITED_ENV,
  ...DEFAULT_INHERITED_ENV,
] as const;

/**
 * Input schema. `ToolTable` validates against this with `ajv` before
 * dispatch, so `execute()` may trust the shape — `command` is a
 * non-empty string, `cwd` is a string when set, `timeout_ms` is a
 * positive number when set. No defensive `typeof` checks below.
 */
const SCHEMA: JSONSchema = {
  type: "object",
  required: ["command"],
  additionalProperties: false,
  properties: {
    command: {
      type: "string",
      minLength: 1,
      description: "The bash command to run.",
    },
    cwd: { type: "string", description: "Optional working directory." },
    timeout_ms: {
      type: "number",
      exclusiveMinimum: 0,
      description: "Optional timeout in milliseconds (default 30000).",
    },
  },
};

interface BashInput {
  command: string;
  cwd?: string;
  timeout_ms?: number;
}

export class BashTool implements Tool {
  public readonly name = "bash";
  public readonly description: string;
  public readonly inputSchema = SCHEMA;
  public readonly requires = ["subprocess"];
  public readonly optional = ["paths", "network", "env"];
  public readonly capabilities: CapabilitySet;

  constructor(_config: ToolConfig, capabilities: CapabilitySet | undefined) {
    this.capabilities = capabilities ?? {};
    // Reject configurations the platform sandbox can't enforce — see
    // each validator for per-kind rationale. Doing this in the
    // constructor surfaces unsupported configs at boot rather than at
    // execute time (or, worse, silently bypassing enforcement).
    if (process.platform === "darwin") {
      validateBashGrant(this.capabilities);
    } else if (process.platform === "linux") {
      validateBashGrantLinux(this.capabilities);
    }
    this.description = describeBash(this.capabilities);
  }

  async audit(): Promise<AuditFinding[]> {
    const findings: AuditFinding[] = [];
    if (!sandboxEngaged(this.capabilities)) {
      findings.push({
        severity: "warning",
        message:
          'capabilities = "*" — bash will run unsandboxed (no OS-level enforcement of paths/network/env).',
        remediation:
          'Replace with a structured grant like { subprocess = "*", paths = ["./"] } to engage the sandbox.',
      });
      return findings;
    }
    if (process.platform === "darwin") {
      const has = await hasSandboxExec();
      if (has) {
        findings.push({
          severity: "ok",
          message:
            "sandbox-exec available; structured grant will engage the macOS sandbox at runtime.",
        });
      } else {
        findings.push({
          severity: "error",
          message:
            "/usr/bin/sandbox-exec not found; bash configured with a structured grant cannot enforce it.",
          remediation:
            'Install Xcode Command Line Tools (`xcode-select --install`), or grant `bash = "*"` to opt out of sandboxing.',
        });
      }
    } else if (process.platform === "linux") {
      const has = await hasBwrap();
      if (has) {
        findings.push({
          severity: "ok",
          message:
            "bwrap available; structured grant will engage the Linux sandbox at runtime.",
        });
      } else {
        findings.push({
          severity: "error",
          message:
            "bwrap (bubblewrap) not found; bash configured with a structured grant cannot enforce it.",
          remediation:
            'Install bubblewrap (e.g. `apt install bubblewrap` on Debian/Ubuntu, `dnf install bubblewrap` on Fedora). Or grant `bash = "*"` to opt out of sandboxing.',
        });
      }
    } else {
      findings.push({
        severity: "warning",
        message: `No sandbox backend on ${process.platform}; structured grants will not enforce at runtime.`,
      });
    }
    return findings;
  }

  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    // Schema-validated upstream by `ToolTable`.
    const {
      command,
      cwd = process.cwd(),
      timeout_ms = 30_000,
    } = input as BashInput;
    const timeout = timeout_ms;

    const env = buildEnv(this.capabilities);

    // Engage the platform sandbox if the grant is structured and the
    // platform's sandbox binary is available. macOS → sandbox-exec,
    // Linux → bwrap. When neither applies (grant is `"*"`, or no
    // platform support, or binary missing), fall through to plain
    // spawn or refuse, depending on the strict-mode rules below.
    let sandboxPrefix: { binary: string; prefixArgs: string[] } | null = null;
    if (process.platform === "darwin") {
      sandboxPrefix = await maybeSandboxExecPrefix(this.capabilities);
    } else if (process.platform === "linux") {
      sandboxPrefix = await maybeBwrapPrefix(this.capabilities);
    }

    let binary: string;
    let args: string[];
    if (sandboxPrefix) {
      binary = sandboxPrefix.binary;
      args = [...sandboxPrefix.prefixArgs, "/bin/bash", "-c", command];
    } else {
      binary = "/bin/bash";
      args = ["-c", command];
      // Strict mode: user wrote a structured grant on a platform we
      // know how to sandbox, but the sandbox binary is missing.
      // Refuse rather than silently bypass enforcement.
      if (sandboxEngaged(this.capabilities)) {
        if (process.platform === "darwin") {
          return {
            content:
              'bash: sandbox-exec is not available, and the grant is structured. Refusing to run unsandboxed. Install Xcode Command Line Tools or grant `bash = "*"` to opt out.',
            isError: true,
          };
        }
        if (process.platform === "linux") {
          return {
            content:
              'bash: bwrap (bubblewrap) is not available, and the grant is structured. Refusing to run unsandboxed. Install bubblewrap (`apt install bubblewrap` / `dnf install bubblewrap`) or grant `bash = "*"` to opt out.',
            isError: true,
          };
        }
      }
    }

    return await new Promise<ToolResult>((resolve) => {
      const child = spawn(binary, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout);

      const onAbort = (): void => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already exited */
        }
      };
      if (ctx.abortSignal.aborted) onAbort();
      else ctx.abortSignal.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
      child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        ctx.abortSignal.removeEventListener("abort", onAbort);
        if (timedOut) {
          resolve({
            content: `bash: timed out after ${timeout}ms\n${stderr}`,
            isError: true,
          });
          return;
        }
        if (code === 0) {
          resolve({ content: stdout });
        } else {
          resolve({
            content: `exit ${code ?? signal}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
            isError: true,
          });
        }
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.abortSignal.removeEventListener("abort", onAbort);
        resolve({ content: `bash: ${err.message}`, isError: true });
      });
    });
  }
}

/** Build the env passed to spawn() from the grant. See top-of-file for semantics. */
export function buildEnv(grant: CapabilitySet): NodeJS.ProcessEnv {
  if (grant === "*") return process.env;
  const e = grant.env;
  if (e === "*") return process.env;
  if (e === undefined) {
    // Convenient default: Tier 1 (always-on) + Tier 2 (overrideable).
    return pickEnv([...ALWAYS_INHERITED_ENV, ...DEFAULT_INHERITED_ENV]);
  }
  if (Array.isArray(e)) {
    // Explicit grant: Tier 1 stays, Tier 2 dropped, plus whatever the
    // user listed. Tier 1 always wins on dedup since pickEnv keys by name.
    const requested = e.filter((n): n is string => typeof n === "string");
    return pickEnv([...ALWAYS_INHERITED_ENV, ...requested]);
  }
  // Object form (richer per-kind structure, currently unused for env):
  // treat as Tier 1 only.
  return pickEnv(ALWAYS_INHERITED_ENV);
}

/**
 * Pick env vars matching the patterns. A pattern is either an exact
 * name (`PATH`) or a prefix-with-trailing-star (`AWS_*`). Trailing `*`
 * is the only supported glob; `*` alone is the same as `env = "*"` and
 * caught upstream. Anything else is treated as a literal name (so
 * `FOO*BAR` matches an env var literally called `FOO*BAR`).
 */
function pickEnv(names: readonly string[]): NodeJS.ProcessEnv {
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
    const v = process.env[name];
    if (v !== undefined) out[name] = v;
  }
  if (prefixes.length > 0) {
    for (const [name, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (prefixes.some((p) => name.startsWith(p))) out[name] = v;
    }
  }
  return out;
}

function describeBash(grant: CapabilitySet): string {
  if (grant === "*") {
    return "Run a bash command. Unrestricted environment (no sandbox engaged).";
  }
  const lines = ["Run a bash command in a sandboxed environment."];
  // Filesystem
  const explicitPaths = paths(grant);
  const fs = resolvedPaths(grant);
  lines.push(`Filesystem: ${describePaths(fs, explicitPaths === null)}.`);
  // Network
  const net = grant.network;
  if (net === undefined) lines.push("Network: no access.");
  else if (net === "*") lines.push("Network: unrestricted.");
  else if (Array.isArray(net)) {
    lines.push(
      net.length === 0
        ? "Network: no access."
        : `Network: limited to ${net.join(", ")}.`,
    );
  }
  // Env. Tier 1 is always present, so describe what's *added* on top.
  const env = grant.env;
  const tier1 = ALWAYS_INHERITED_ENV.join(", ");
  if (env === undefined) {
    const tier2 = DEFAULT_INHERITED_ENV.join(", ");
    lines.push(
      `Environment: always inherited (${tier1}) plus defaults (${tier2}); no credentials.`,
    );
  } else if (env === "*") {
    lines.push("Environment: full passthrough (every process env var).");
  } else if (Array.isArray(env)) {
    lines.push(
      env.length === 0
        ? `Environment: always inherited only (${tier1}).`
        : `Environment: always inherited (${tier1}) plus ${env.join(", ")}.`,
    );
  }
  return lines.join(" ");
}
