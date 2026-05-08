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
 *   env absent          → SAFE-DEFAULTS subset of process.env (PATH,
 *                         HOME, USER, TERM, locale, etc.) is passed
 *                         through. NO credentials, tokens, or secrets.
 *                         The exact list is `SAFE_DEFAULT_ENV_NAMES`
 *                         below; tools that want strict no-env should
 *                         set `env = []` explicitly.
 *   env = "*"           → process.env passed through unfiltered.
 *   env = []            → empty env (explicit opt-out of safe defaults).
 *   env = ["NAME"]      → exact name from process.env.
 *   env = ["AWS_*"]     → prefix match — every name starting with
 *                         `AWS_`. Trailing `*` only; no other glob
 *                         metacharacters. Mixable with exact names:
 *                         `env = ["AWS_*", "PATH"]`.
 *
 * The asymmetry: absent = denied is the right default for `paths` and
 * `network` (less access is safer). For `env`, absent = empty would
 * break command resolution entirely, which would push users toward
 * `"*"` (full leak). Smart defaults is the actually-safe middle.
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
 * Curated env names passed through to bash when `env` is not
 * explicitly granted. Conservative: things shells need to function
 * (PATH, locale, terminal info) and nothing that looks like a
 * credential. Exported so audit + description rendering can show the
 * exact list.
 */
export const SAFE_DEFAULT_ENV_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
] as const;

const SCHEMA: JSONSchema = {
  type: "object",
  required: ["command"],
  properties: {
    command: { type: "string", description: "The bash command to run." },
    cwd: { type: "string", description: "Optional working directory." },
    timeout_ms: {
      type: "number",
      description: "Optional timeout in milliseconds (default 30000).",
    },
  },
};

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
    const i = input as {
      command?: unknown;
      cwd?: unknown;
      timeout_ms?: unknown;
    };
    if (typeof i.command !== "string" || !i.command) {
      return { content: "bash: 'command' is required", isError: true };
    }
    const cwd = typeof i.cwd === "string" ? i.cwd : process.cwd();
    const timeout =
      typeof i.timeout_ms === "number" && i.timeout_ms > 0
        ? i.timeout_ms
        : 30_000;

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
      args = [
        ...sandboxPrefix.prefixArgs,
        "/bin/bash",
        "-c",
        i.command as string,
      ];
    } else {
      binary = "/bin/bash";
      args = ["-c", i.command as string];
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
function buildEnv(grant: CapabilitySet): NodeJS.ProcessEnv {
  if (grant === "*") return process.env;
  const e = grant.env;
  if (e === undefined) return pickEnv(SAFE_DEFAULT_ENV_NAMES);
  if (e === "*") return process.env;
  if (Array.isArray(e)) {
    return pickEnv(e.filter((n): n is string => typeof n === "string"));
  }
  return {};
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
  // Env
  const env = grant.env;
  if (env === undefined) {
    lines.push(
      `Environment: safe defaults (${SAFE_DEFAULT_ENV_NAMES.join(", ")}); no credentials.`,
    );
  } else if (env === "*") {
    lines.push("Environment: full passthrough (every process env var).");
  } else if (Array.isArray(env)) {
    lines.push(
      env.length === 0
        ? "Environment: empty."
        : `Environment: ${env.join(", ")} only.`,
    );
  }
  return lines.join(" ");
}
