import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { expandHome } from "../../internal/util.js";
import { defaultContains, defaultMerge } from "../../manifest/capabilities.js";
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
import type {
  CapabilityGrant,
  CapabilitySet,
  CapabilityValue,
} from "../../types/manifest.js";
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
import { setupCommandBroker, type CommandBroker } from "../sandbox/broker.js";
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
  private readonly rows: readonly CapabilityGrant[] | null;
  private readonly generalRow: CapabilityGrant | null;
  private readonly singleGrant: "*" | CapabilityGrant;

  constructor(_config: ToolConfig, capabilities: CapabilitySet | undefined) {
    this.capabilities = capabilities ?? {};

    const rowSet =
      this.capabilities === "*"
        ? "*"
        : Array.isArray(this.capabilities)
          ? this.capabilities
          : [this.capabilities];

    if (rowSet !== "*" && rowSet.length > 1) {
      this.rows = rowSet;
      this.generalRow = rowSet.find((row) => row.commands === "*") ?? null;
      this.singleGrant = this.generalRow ?? {};
      this.mode = "shell";
      this.allowedCommands = null;
      this.inputSchema = SHELL_SCHEMA;
      for (const row of rowSet) validateGrantRow(row);
      validateDisjointCommands(rowSet);
    } else {
      const single: "*" | CapabilityGrant =
        rowSet === "*" ? "*" : (rowSet[0] ?? {});
      this.rows = null;
      this.generalRow = null;
      this.singleGrant = single;
      const cmds = readCommandsGrant(single);
      if (Array.isArray(cmds)) {
        this.mode = "argv";
        this.allowedCommands = cmds;
        this.inputSchema = argvSchema(cmds);
      } else {
        this.mode = "shell";
        this.allowedCommands = null;
        this.inputSchema = SHELL_SCHEMA;
      }
      validateGrantRow(single);
    }

    this.description = describeBash(
      this.capabilities,
      this.mode,
      this.allowedCommands,
    );
  }

  containsGrant(
    superset: CapabilitySet | undefined,
    subset: CapabilitySet,
  ): boolean {
    if (superset === "*") return true;
    if (subset === "*") return false;
    const subsetRows = Array.isArray(subset) ? subset : [subset];
    if (superset === undefined) {
      return subsetRows.every((row) => Object.keys(row).length === 0);
    }
    const supersetRows = Array.isArray(superset) ? superset : [superset];
    return subsetRows.every((subsetRow) =>
      supersetRows.some((supersetRow) =>
        bashRowContains(supersetRow, subsetRow),
      ),
    );
  }

  mergeGrants(a: CapabilitySet, b: CapabilitySet): CapabilitySet {
    return defaultMerge(a, b);
  }

  // Valid-grant generator for the capability-algebra conformance checker
  // (audit/tests only). Spans bash's full, complex value space so the laws
  // are exercised across every corner:
  //   commands : "*" (all) | a non-empty command enum
  //   network  : "*" (on)  | [] (off) | absent (off)
  //   paths    : "*"       | dirs incl. nested prefixes (./ ⊃ ./src ⊃ …)
  //   env      : "*"       | a var allowlist | absent
  //   shape    : "*" | {} | a single row | a row set (1–4 rows)
  sampleGrant(random: () => number): CapabilitySet {
    const pick = <T>(xs: readonly T[]): T =>
      xs[Math.floor(random() * xs.length)] as T;
    const subset = <T>(xs: readonly T[]): T[] => {
      const out = xs.filter(() => random() < 0.5);
      return out.length > 0 ? out : [pick(xs)]; // keep allowlists non-empty
    };
    const commands = (): CapabilityValue =>
      random() < 0.4
        ? "*"
        : subset(["cat", "gcalcli", "git", "dig", "jq", "curl"]);
    const network = (): CapabilityValue => (random() < 0.5 ? "*" : []);
    const paths = (): CapabilityValue =>
      random() < 0.35
        ? "*"
        : subset(["./", "./src", "./src/deep", "~/.config", "/tmp"]);
    const env = (): CapabilityValue =>
      random() < 0.35 ? "*" : subset(["PATH", "HOME", "FOO", "BAR"]);
    const row = (): CapabilityGrant => {
      const r: CapabilityGrant = {};
      if (random() < 0.85) r.commands = commands();
      if (random() < 0.6) r.paths = paths();
      if (random() < 0.55) r.network = network();
      if (random() < 0.4) r.env = env();
      return r;
    };
    const shape = random();
    if (shape < 0.1) return "*";
    if (shape < 0.18) return {};
    if (shape < 0.55) return row();
    const n = 1 + Math.floor(random() * 4);
    return Array.from({ length: n }, row);
  }

  async audit(): Promise<AuditFinding[]> {
    const findings: AuditFinding[] = [];
    if (this.capabilities === "*") {
      findings.push({
        severity: "warning",
        message:
          'capabilities = "*" — bash will run unsandboxed (no OS-level enforcement of paths/network/env).',
        remediation:
          'Replace with a structured grant like { commands = "*", paths = ["./"] } to engage the sandbox.',
      });
      return findings;
    }
    // env = "*" is honored literally (full environment, secrets included), so
    // audit names the exposed secrets rather than silently stripping them.
    const grantRows = Array.isArray(this.capabilities)
      ? this.capabilities
      : [this.capabilities];
    if (grantRows.some((row) => row.env === "*")) {
      const exposed = Object.keys(process.env)
        .filter(isSensitiveEnvName)
        .sort();
      const secretList =
        exposed.length > 0 ? exposed.join(", ") : "none currently set";
      findings.push({
        severity: "warning",
        message: `env = "*" — bash inherits the full environment, exposing secrets to the agent's shell (e.g. via \`env\`): ${secretList}.`,
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
    if (this.rows) {
      return this.executeRowSet(input as ShellInput, ctx);
    }
    const dispatch =
      this.mode === "argv" && this.allowedCommands
        ? buildArgvDispatch(input as ArgvInput, this.allowedCommands)
        : buildShellDispatch(input as ShellInput);
    return this.run(dispatch, this.singleGrant, ctx);
  }

  private async executeRowSet(
    input: ShellInput,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const rows = this.rows ?? [];
    // Fast path: a plain `cmd args` invocation of a per-command row's command
    // runs directly under that row — no shell. When a general row exists the
    // broker (below) would reach the same command with the same grant, so
    // this is purely an optimization that skips standing up the broker. When
    // there is NO general row it is also the only way to run the command at
    // all: with no shell, there is nothing for the broker to live inside.
    const argv = tokenizeSimpleCommand(input.command ?? "");
    const program = argv === null ? undefined : argv[0];
    if (argv !== null && program !== undefined) {
      const promotedRow = rows.find(
        (row) => Array.isArray(row.commands) && row.commands.includes(program),
      );
      if (promotedRow) {
        return this.run(
          {
            childProgram: program,
            childArgs: argv.slice(1),
            cwd: input.cwd ?? process.cwd(),
            timeout: input.timeout_ms ?? 30_000,
            displayLabel: describeCommand(input.command),
          },
          promotedRow,
          ctx,
        );
      }
    }
    if (this.generalRow) {
      // Per-command rows reachable from inside the general shell: a brokered
      // shim runs each in its own row sandbox, so `dig … | jq` and
      // interpreter-laundered calls get their grant too — not just plain
      // top-level invocations.
      const specificRows = rows.filter((r) => Array.isArray(r.commands));
      const broker =
        specificRows.length > 0 && sandboxEngaged(this.generalRow)
          ? await setupCommandBroker(specificRows)
          : null;
      try {
        return await this.run(
          buildShellDispatch(input),
          this.generalRow,
          ctx,
          broker,
        );
      } finally {
        await broker?.close();
      }
    }
    const direct = directCommandNames(rows);
    return {
      content:
        `bash: this grant only allows direct invocation of: ${direct.join(", ")}. ` +
        `Call it as a plain command (no pipes, substitutions, or interpreters) to use its grant.`,
      isError: true,
    };
  }

  private async run(
    dispatch: DispatchPlan,
    grant: "*" | CapabilityGrant,
    ctx: ToolContext,
    broker?: CommandBroker | null,
  ): Promise<ToolResult> {
    const { childProgram, childArgs, cwd, timeout, displayLabel } = dispatch;

    const env = buildEnv(grant);
    // Seed PWD with the canonical working directory. bash recomputes PWD via
    // getcwd at startup when it can, but the sandbox can deny getcwd (the
    // "shell-init" warning); without this the shell — and any broker shim it
    // spawns — would fall back to the orchestrator's PWD and run in the wrong
    // place. Canonical so `pwd` and the granted subpaths agree.
    env.PWD = await canonicalizeCwd(cwd);
    if (broker) {
      env.PATH = broker.shimDir + path.delimiter + (env.PATH ?? "");
    }

    let sandboxPrefix: { binary: string; prefixArgs: string[] } | null = null;
    if (process.platform === "darwin") {
      sandboxPrefix = await maybeSandboxExecPrefix(grant, broker?.access);
    } else if (process.platform === "linux") {
      sandboxPrefix = await maybeBwrapPrefix(grant, broker?.access);
    }

    let binary: string;
    let args: string[];
    if (sandboxPrefix) {
      binary = sandboxPrefix.binary;
      args = [...sandboxPrefix.prefixArgs, childProgram, ...childArgs];
    } else {
      binary = childProgram;
      args = childArgs;
      if (sandboxEngaged(grant)) {
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
  // tool_call_update referencing this terminalId makes it render nothing.
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

// Provider/harness API keys plus everything promoted via EnvSecretsStore's
// `LOOM_` convention — the names audit() lists when env = "*" exposes them.
function isSensitiveEnvName(name: string): boolean {
  return name.startsWith("LOOM_") || name.endsWith("_API_KEY");
}

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

function describeCommand(cmd: string): string {
  const oneLine = cmd.replace(/\s+/g, " ").trim();
  const max = 60;
  const truncated =
    oneLine.length > max ? oneLine.slice(0, max - 1) + "\u2026" : oneLine;
  return `bash: ${truncated}`;
}

function validateGrantRow(row: "*" | CapabilityGrant): void {
  if (process.platform === "darwin") {
    validateBashGrant(row);
  } else if (process.platform === "linux") {
    validateBashGrantLinux(row);
  }
}

// Dispatch is a piecewise function: a command runs under its specific
// (array `commands`) row, or the general `commands = "*"` row as a fallback.
// The `"*"` row never competes for a named command, but two specific rows
// that share a command have no well-defined winner — "most specific" is
// undefined for overlapping non-nested allowlists. Rather than silently pick
// by list order, require the specific rows to be disjoint so every command
// has exactly one home.
function validateDisjointCommands(rows: readonly CapabilityGrant[]): void {
  const claimedBy = new Map<string, number>();
  rows.forEach((row, index) => {
    if (!Array.isArray(row.commands)) return;
    for (const command of row.commands) {
      if (typeof command !== "string") continue;
      const prior = claimedBy.get(command);
      if (prior !== undefined && prior !== index) {
        throw new Error(
          `bash: command '${command}' is claimed by more than one capability ` +
            `row (rows ${prior} and ${index}). A command may belong to at most ` +
            `one row so its sandbox is unambiguous — split overlapping ` +
            `allowlists into disjoint rows.`,
        );
      }
      claimedBy.set(command, index);
    }
  });
}

function directCommandNames(rows: readonly CapabilityGrant[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!Array.isArray(row.commands)) continue;
    for (const command of row.commands) {
      if (typeof command !== "string" || seen.has(command)) continue;
      seen.add(command);
      names.push(command);
    }
  }
  return names;
}

function bashRowContains(
  supersetRow: CapabilityGrant,
  subsetRow: CapabilityGrant,
): boolean {
  for (const [kind, subsetValue] of Object.entries(subsetRow)) {
    if (subsetValue === undefined) continue;
    if (!Object.hasOwn(supersetRow, kind)) return false;
    const supersetValue = supersetRow[kind];
    if (kind === "paths") {
      if (!pathGrantContains(supersetValue, subsetValue)) return false;
    } else if (!defaultContains(supersetValue, subsetValue)) {
      return false;
    }
  }
  return true;
}

function pathGrantContains(superset: unknown, subset: unknown): boolean {
  if (superset === "*") return true;
  if (subset === "*") return false;
  if (!Array.isArray(superset) || !Array.isArray(subset)) return false;
  const supersetRoots = superset
    .filter((p): p is string => typeof p === "string")
    .map(resolveGrantPath);
  return subset.every(
    (p) =>
      typeof p === "string" &&
      supersetRoots.some((root) =>
        isPathUnderOrEqual(resolveGrantPath(p), root),
      ),
  );
}

function resolveGrantPath(p: string): string {
  return path.resolve(expandHome(p));
}

function isPathUnderOrEqual(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

const BARE_WORD_CHAR = /[A-Za-z0-9_\-./:=@+,%]/;
const ENV_ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Conservative splitter deciding row promotion: accepts only commands a POSIX
// shell would parse into a plain argv with zero evaluation (safe-charset bare
// words, single quotes, double quotes free of $/`/\). Anything else — incl.
// env assignment prefixes — returns null and falls back to the general row.
export function tokenizeSimpleCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < command.length) {
    if (command.charAt(i) === " " || command.charAt(i) === "\t") {
      i++;
      continue;
    }
    let word = "";
    while (i < command.length) {
      const c = command.charAt(i);
      if (c === " " || c === "\t") break;
      if (c === "'") {
        const close = command.indexOf("'", i + 1);
        if (close === -1) return null;
        word += command.slice(i + 1, close);
        i = close + 1;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        while (j < command.length && command.charAt(j) !== '"') {
          const inner = command.charAt(j);
          if (inner === "$" || inner === "`" || inner === "\\") return null;
          j++;
        }
        if (j >= command.length) return null;
        word += command.slice(i + 1, j);
        i = j + 1;
        continue;
      }
      if (BARE_WORD_CHAR.test(c)) {
        word += c;
        i++;
        continue;
      }
      return null;
    }
    tokens.push(word);
  }
  const first = tokens[0];
  if (first === undefined) return null;
  if (ENV_ASSIGNMENT_PREFIX.test(first)) return null;
  return tokens;
}

function readCommandsGrant(
  grant: "*" | CapabilityGrant,
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

async function canonicalizeCwd(cwd: string): Promise<string> {
  const abs = path.resolve(cwd);
  try {
    return await fs.realpath(abs);
  } catch {
    return abs;
  }
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
  const rows = Array.isArray(grant) ? grant : [grant];
  if (rows.length <= 1) {
    return describeSingleGrant(rows[0] ?? {}, mode, allowedCommands);
  }
  const generalRow = rows.find((row) => row.commands === "*");
  const directRows = rows.filter((row) => Array.isArray(row.commands));
  const directSummary = directRows.map(describeDirectRow).join("; ");
  if (generalRow === undefined) {
    return (
      `Run one of these commands directly (plain \`cmd args...\` form only; ` +
      `no pipes, substitutions, or interpreters), each with its own grant: ${directSummary}.`
    );
  }
  const base = describeSingleGrant(generalRow, "shell", null);
  if (directRows.length === 0) return base;
  return (
    `${base} These commands carry their own grants wherever they run — ` +
    `on their own, in a pipeline, or invoked from a script: ${directSummary}.`
  );
}

function describeDirectRow(row: CapabilityGrant): string {
  const names = (Array.isArray(row.commands) ? row.commands : [])
    .filter((c): c is string => typeof c === "string")
    .map((c) => `\`${c}\``)
    .join(", ");
  const parts: string[] = [];
  const network = row.network;
  if (network === "*") parts.push("network access");
  else if (Array.isArray(network) && network.length > 0) {
    parts.push(`network: ${network.join(", ")}`);
  }
  const grantedPaths = row.paths;
  if (grantedPaths === "*") parts.push("unrestricted filesystem");
  else if (Array.isArray(grantedPaths) && grantedPaths.length > 0) {
    parts.push(`filesystem: ${grantedPaths.join(", ")}`);
  }
  return parts.length === 0 ? names : `${names} (${parts.join("; ")})`;
}

function describeSingleGrant(
  grant: CapabilityGrant,
  mode: DispatchMode,
  allowedCommands: readonly string[] | null,
): string {
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
