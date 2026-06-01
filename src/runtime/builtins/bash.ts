import { spawn } from "node:child_process";

import type {
  EnvVariable,
  TerminalHandle,
  ToolCallContent,
} from "../../types/acp.js";
import type {
  AuditFinding,
  Tool,
  ToolConfig,
  ToolContext,
  ToolDisplay,
  ToolResult,
} from "../../types/interfaces.js";
import type { CapabilitySet, CapabilityValue } from "../../types/manifest.js";
import type { JSONSchema } from "../../types/schema.js";

import type { ClientBridge } from "../client-bridge.js";
import { raceAbort } from "../client-bridge.js";
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

const SHELL_SCHEMA: JSONSchema = {
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

function argvSchema(commands: readonly string[]): JSONSchema {
  const argsProp = {
    type: "array",
    items: { type: "string" },
    description: "Arguments to pass on the command line.",
  };
  const cwdProp = {
    type: "string",
    description: "Optional working directory.",
  };
  const timeoutProp = {
    type: "number",
    exclusiveMinimum: 0,
    description: "Optional timeout in milliseconds (default 30000).",
  };
  if (commands.length === 1) {
    const [name] = commands;
    return {
      type: "object",
      additionalProperties: false,
      description: `Run \`${name}\` directly (no shell).`,
      properties: {
        args: argsProp,
        cwd: cwdProp,
        timeout_ms: timeoutProp,
      },
    };
  }
  return {
    type: "object",
    required: ["command"],
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        enum: [...commands],
        description: "Which command to run.",
      },
      args: argsProp,
      cwd: cwdProp,
      timeout_ms: timeoutProp,
    },
  };
}

interface ShellInput {
  command: string;
  cwd?: string;
  timeout_ms?: number;
}

interface ArgvInput {
  command?: string;
  args?: string[];
  cwd?: string;
  timeout_ms?: number;
}

type DispatchMode = "shell" | "argv";

export class BashTool implements Tool {
  public readonly name = "bash";
  public readonly description: string;
  public readonly inputSchema: JSONSchema;
  public readonly requires = ["commands"];
  public readonly optional = ["paths", "network", "env"];
  public readonly capabilities: CapabilitySet;

  private readonly mode: DispatchMode;
  private readonly allowedCommands: readonly string[] | null;

  constructor(_config: ToolConfig, capabilities: CapabilitySet | undefined) {
    this.capabilities = capabilities ?? {};

    const cmds = readCommandsGrant(this.capabilities);
    if (Array.isArray(cmds)) {
      this.mode = "argv";
      this.allowedCommands = cmds;
      this.inputSchema = argvSchema(cmds);
    } else {
      this.mode = "shell";
      this.allowedCommands = null;
      this.inputSchema = SHELL_SCHEMA;
    }

    if (process.platform === "darwin") {
      validateBashGrant(this.capabilities);
    } else if (process.platform === "linux") {
      validateBashGrantLinux(this.capabilities);
    }
    this.description = describeBash(
      this.capabilities,
      this.mode,
      this.allowedCommands,
    );
  }

  async audit(): Promise<AuditFinding[]> {
    const findings: AuditFinding[] = [];
    if (!sandboxEngaged(this.capabilities)) {
      findings.push({
        severity: "warning",
        message:
          'capabilities = "*" — bash will run unsandboxed (no OS-level enforcement of paths/network/env).',
        remediation:
          'Replace with a structured grant like { commands = "*", paths = ["./"] } to engage the sandbox.',
      });
      return findings;
    }
    // env = "*" hands bash the ENTIRE environment, including provider API keys
    // and LOOM_-promoted secrets. That's an explicit grant we honor literally,
    // but it's worth surfacing loudly — and naming the secrets it exposes — in
    // `loom audit`, mirroring the unsandboxed warning above.
    if (this.capabilities !== "*" && this.capabilities.env === "*") {
      const exposed = Object.keys(process.env).filter(isSensitiveEnvName).sort();
      const secretList =
        exposed.length > 0 ? exposed.join(", ") : "none currently set";
      findings.push({
        severity: "warning",
        message:
          `env = "*" — bash inherits the full environment, exposing secrets to the agent's shell (e.g. via \`env\`): ${secretList}.`,
        remediation:
          'If that is not intended, grant only the variables bash needs, e.g. { env = ["PATH", "FOO"] }.',
      });
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
    const dispatch =
      this.mode === "argv" && this.allowedCommands
        ? buildArgvDispatch(input as ArgvInput, this.allowedCommands)
        : buildShellDispatch(input as ShellInput);
    const { childProgram, childArgs, cwd, timeout, displayLabel } = dispatch;

    const env = buildEnv(this.capabilities);

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
      args = [...sandboxPrefix.prefixArgs, childProgram, ...childArgs];
    } else {
      binary = childProgram;
      args = childArgs;
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

    if (ctx.client?.createTerminal) {
      return runViaClientTerminal(ctx.client, {
        binary,
        args,
        cwd,
        timeout,
        displayLabel,
        env,
        abortSignal: ctx.abortSignal,
      });
    }

    const baseDisplay: ToolDisplay = {
      title: displayLabel,
      kind: "execute",
    };
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
          // already exited
        }
      };
      if (ctx.abortSignal.aborted) onAbort();
      else ctx.abortSignal.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
      child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        ctx.abortSignal.removeEventListener("abort", onAbort);
        const display: ToolDisplay = {
          ...baseDisplay,
          rawOutput: { exitCode: code, signal },
        };
        if (timedOut) {
          resolve({
            content: `bash: timed out after ${timeout}ms\n${stderr}`,
            isError: true,
            display,
          });
          return;
        }
        if (code === 0) {
          resolve({ content: stdout, display });
        } else {
          resolve({
            content: `exit ${code ?? signal}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
            isError: true,
            display,
          });
        }
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.abortSignal.removeEventListener("abort", onAbort);
        resolve({
          content: `bash: ${err.message}`,
          isError: true,
          display: baseDisplay,
        });
      });
    });
  }
}

async function runViaClientTerminal(
  client: ClientBridge,
  opts: {
    binary: string;
    args: string[];
    cwd: string;
    timeout: number;
    displayLabel: string;
    env: NodeJS.ProcessEnv;
    abortSignal: AbortSignal;
  },
): Promise<ToolResult> {
  const { binary, args, cwd, timeout, displayLabel, env, abortSignal } = opts;

  const createTerminal = client.createTerminal;
  if (!createTerminal) {
    return { content: "bash: client terminal not available", isError: true };
  }

  const handle: TerminalHandle = await createTerminal({
    command: binary,
    args,
    cwd,
    env: toEnvVariables(env),
    outputByteLimit: 1_000_000,
  });

  const terminalContent: ToolCallContent = {
    type: "terminal",
    terminalId: handle.id,
  };
  const baseDisplay: ToolDisplay = {
    title: displayLabel,
    kind: "execute",
    content: [terminalContent],
  };

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void handle.kill().catch(() => undefined);
  }, timeout);

  // Deliberately no handle.release(): releasing before the client receives the
  // tool_call_update referencing this terminalId makes it render nothing. The
  // client caps output and releases session terminals on close.
  try {
    const exit = await raceAbort(handle.waitForExit(), abortSignal, () => {
      void handle.kill().catch(() => undefined);
    });
    clearTimeout(timer);

    const { output } = await handle.currentOutput();
    const exitCode = exit.exitCode ?? null;
    const signal = exit.signal ?? null;
    const display: ToolDisplay = {
      ...baseDisplay,
      rawOutput: { exitCode, signal },
    };

    if (timedOut) {
      return {
        content: `bash: timed out after ${timeout}ms\n${output}`,
        isError: true,
        display,
      };
    }
    if (exitCode === 0 && signal === null) {
      return { content: output, display };
    }
    return {
      content: `exit ${exitCode ?? signal}\n${output}`,
      isError: true,
      display,
    };
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `bash: ${message}`,
      isError: true,
      display: baseDisplay,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Secret-like env names: provider/harness API keys (e.g. ANTHROPIC_API_KEY,
// OPENAI_API_KEY) and everything promoted via the `LOOM_` convention used by
// EnvSecretsStore. `env = "*"` is an EXPLICIT grant and deliberately DOES expose
// these to bash — we don't silently strip them — but `audit()` lists them by
// name so the operator sees exactly which secrets a wildcard env grant hands to
// the agent's shell.
function isSensitiveEnvName(name: string): boolean {
  return name.startsWith("LOOM_") || name.endsWith("_API_KEY");
}

export function buildEnv(grant: CapabilitySet): NodeJS.ProcessEnv {
  // `*` / `env = "*"` is an explicit request for the whole environment, secrets
  // included — honor it literally. Return a shallow copy rather than the live
  // process.env so callers can't mutate the orchestrator's environment; the
  // values (including secrets) are still all present. `audit()` warns and names
  // the exposed secrets so this is never a silent leak.
  if (grant === "*") return { ...process.env };
  const e = grant.env;
  if (e === "*") return { ...process.env };
  if (e === undefined) {
    return pickEnv([...ALWAYS_INHERITED_ENV, ...DEFAULT_INHERITED_ENV]);
  }
  if (Array.isArray(e)) {
    const requested = e.filter((n): n is string => typeof n === "string");
    return pickEnv([...ALWAYS_INHERITED_ENV, ...requested]);
  }
  return pickEnv(ALWAYS_INHERITED_ENV);
}

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

function describeCommand(cmd: string): string {
  const oneLine = cmd.replace(/\s+/g, " ").trim();
  const max = 60;
  const truncated =
    oneLine.length > max ? oneLine.slice(0, max - 1) + "\u2026" : oneLine;
  return `bash: ${truncated}`;
}

function readCommandsGrant(
  grant: CapabilitySet,
): "*" | readonly string[] | undefined {
  if (grant === "*") return "*";
  const c: CapabilityValue | undefined = grant.commands;
  if (c === "*") return "*";
  if (Array.isArray(c)) {
    const list = c.filter((x): x is string => typeof x === "string");
    return list.length > 0 ? list : undefined;
  }
  return undefined;
}

interface DispatchPlan {
  childProgram: string;
  childArgs: string[];
  cwd: string;
  timeout: number;
  displayLabel: string;
}

function buildShellDispatch(input: ShellInput): DispatchPlan {
  const cwd = input.cwd ?? process.cwd();
  const timeout = input.timeout_ms ?? 30_000;
  return {
    childProgram: "/bin/bash",
    childArgs: ["-c", input.command],
    cwd,
    timeout,
    displayLabel: describeCommand(input.command),
  };
}

function buildArgvDispatch(
  input: ArgvInput,
  allowed: readonly string[],
): DispatchPlan {
  const cwd = input.cwd ?? process.cwd();
  const timeout = input.timeout_ms ?? 30_000;
  const args = input.args ?? [];
  const picked = allowed.length === 1 ? allowed[0] : input.command;
  if (!picked || !allowed.includes(picked)) {
    throw new Error(
      `bash: command "${picked ?? ""}" is not in the allowlist (${allowed.join(", ")}).`,
    );
  }
  return {
    childProgram: picked,
    childArgs: args,
    cwd,
    timeout,
    displayLabel: describeCommand(
      args.length === 0 ? picked : `${picked} ${args.join(" ")}`,
    ),
  };
}

function toEnvVariables(env: NodeJS.ProcessEnv): EnvVariable[] {
  const out: EnvVariable[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string") out.push({ name, value });
  }
  return out;
}

function describeBash(
  grant: CapabilitySet,
  mode: DispatchMode,
  allowedCommands: readonly string[] | null,
): string {
  if (grant === "*") {
    return "Run a bash command. Unrestricted environment (no sandbox engaged).";
  }
  const lede =
    mode === "argv" && allowedCommands
      ? allowedCommands.length === 1
        ? `Run \`${allowedCommands[0]}\` directly (no shell) in a sandboxed environment.`
        : `Run one of (${allowedCommands.join(", ")}) directly (no shell) in a sandboxed environment.`
      : "Run a bash command in a sandboxed environment.";
  const lines = [lede];
  const explicitPaths = paths(grant);
  const fs = resolvedPaths(grant);
  lines.push(`Filesystem: ${describePaths(fs, explicitPaths === null)}.`);
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
