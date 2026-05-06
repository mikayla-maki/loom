/**
 * Tool table + ProcessTool — invoke tools as child processes.
 *
 * Wire format:
 *   stdin  = JSON-encoded input
 *   stdout = string result (utf-8) on exit code 0
 *   stderr = error string when exit != 0
 *   env    = system whitelist + tool-declared secrets only
 */

import { spawn } from "node:child_process";
import * as path from "node:path";

import Ajv from "ajv";

import { ToolExecutionError, ToolInputError } from "../errors.js";
import type {
  Tool,
  ToolCall,
  ToolDescriptor,
  ToolResult,
} from "../types/interfaces.js";
import type { ToolManifest } from "../types/manifest.js";

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });

/**
 * Env vars passed through to every tool subprocess. The parent's env
 * frequently holds unrelated credentials we don't want tools to see, so
 * we pass through ONLY this whitelist (plus tool-declared secrets).
 */
const SYSTEM_ENV_WHITELIST = [
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_OPTIONS",
  "NODE_ENV",
  "NODE_PATH",
  "PWD",
] as const;

/**
 * Per-spawn broker binding. When set, ProcessTool injects
 * LOOM_INVOKE_TOKEN + LOOM_INVOKE_SOCKET into the child's env, and the
 * caller is responsible for revoking the token after the child exits.
 *
 * The function returns a fresh token (or `null` if no broker) and a
 * matching revoke callback. Calling the broker once per execute() means
 * each tool invocation gets a short-lived credential; long-running tool
 * processes don't keep tokens alive across multiple calls.
 */
export interface BrokerBinding {
  socketPath: string;
  /** Mint a token bound to this tool's owning skill. */
  mintToken(): string;
  revokeToken(token: string): void;
}

export interface ProcessToolOptions {
  /** Extra env vars merged on top (useful for tests). */
  env?: Record<string, string>;
  cwd?: string;
  /** Prepended to PATH — usually each tool's own bin/ if shipsBinary. */
  extraPath?: string[];
  /** 0 = no timeout. */
  timeoutMs?: number;
  /** Wire spawned children to a LoomServer broker for subagent invocation. */
  broker?: BrokerBinding;
}

export class ProcessTool implements Tool {
  public readonly name: string;
  public readonly description: string;
  public readonly inputSchema: ToolManifest["schema"];
  private readonly validate: import("ajv").ValidateFunction;

  constructor(
    public readonly manifest: ToolManifest,
    private readonly options: ProcessToolOptions = {},
  ) {
    this.name = manifest.name ?? "";
    this.description = manifest.description;
    this.inputSchema = manifest.schema;
    try {
      this.validate = ajv.compile(this.inputSchema as object);
    } catch (e) {
      throw new ToolInputError(
        `Invalid JSON schema for tool '${this.name}': ${(e as Error).message}`,
        { cause: e },
      );
    }
  }

  async execute(
    input: unknown,
    secrets: Record<string, string>,
  ): Promise<ToolResult> {
    if (!this.validate(input)) {
      const errors = (this.validate.errors ?? [])
        .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`)
        .join("; ");
      throw new ToolInputError(
        `Tool '${this.name}' input failed validation: ${errors}`,
      );
    }

    // Per-execution broker token. Minted just before spawn, revoked when
    // the child exits (success or failure).
    const broker = this.shouldWireBroker() ? this.options.broker : undefined;
    const brokerToken = broker ? broker.mintToken() : null;

    const env = this.buildEnv(secrets, broker, brokerToken);
    const cwd = this.options.cwd ?? this.manifest.toolDir;
    const command = this.manifest.invocation.command;
    const args = this.manifest.invocation.args ?? [];
    const timeout = this.options.timeoutMs ?? 0;

    return new Promise<ToolResult>((resolve, reject) => {
      const revokeIfMinted = () => {
        if (broker && brokerToken) broker.revokeToken(brokerToken);
      };
      const child = spawn(command, args, {
        env,
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer =
        timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, timeout)
          : null;

      child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
      child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        revokeIfMinted();
        reject(
          new ToolExecutionError(
            `Tool '${this.name}' failed to spawn: ${err.message}`,
            this.name,
            null,
            stderr,
          ),
        );
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        revokeIfMinted();
        if (timedOut) {
          reject(
            new ToolExecutionError(
              `Tool '${this.name}' timed out after ${timeout}ms`,
              this.name,
              null,
              stderr,
            ),
          );
          return;
        }
        if (code === 0) {
          resolve({ content: stdout.trimEnd() });
        } else {
          // Surface failure into the tool result instead of throwing — the
          // model needs to see what went wrong to adapt.
          resolve({
            content:
              stderr ||
              stdout ||
              `tool '${this.name}' exited with code ${code}`,
            isError: true,
          });
        }
      });

      child.stdin.end(JSON.stringify(input));
    });
  }

  /**
   * Only wire the broker for tools that explicitly declare `subagent`
   * capability. A tool with no subagent capability gets no token and
   * (because LOOM_INVOKE_SOCKET is also unset) cannot reach the broker.
   */
  private shouldWireBroker(): boolean {
    if (!this.options.broker) return false;
    const sa = this.manifest.capabilities?.subagent;
    if (sa === "*") return true;
    return Array.isArray(sa) && sa.length > 0;
  }

  private buildEnv(
    secrets: Record<string, string>,
    broker: BrokerBinding | undefined,
    brokerToken: string | null,
  ): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = {};
    for (const key of SYSTEM_ENV_WHITELIST) {
      const v = process.env[key];
      if (typeof v === "string") base[key] = v;
    }
    base.PATH = [
      ...(this.options.extraPath ?? []),
      process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ]
      .filter(Boolean)
      .join(path.delimiter);

    // The secrets bag passed in is already filtered by ToolTable to this
    // tool's allowlist; just inject everything.
    for (const [name, value] of Object.entries(secrets)) {
      base[name] = value;
      base[name.replace(/[.\-]/g, "_").toUpperCase()] = value;
    }

    // Broker wiring: only inject when this tool is allowed to call the
    // broker (subagent capability declared) AND a broker is bound.
    if (broker && brokerToken) {
      base.LOOM_INVOKE_SOCKET = broker.socketPath;
      base.LOOM_INVOKE_TOKEN = brokerToken;
    }

    if (this.options.env) Object.assign(base, this.options.env);
    base.LOOM_TOOL_NAME = this.name;
    return base;
  }
}

/**
 * Tool registration entry. Each tool ships an `allowedSecrets` set of
 * names — the union of `[tool.secrets].required` and `optional` from its
 * manifest, or an empty set for privileged in-process builtins. The
 * `ToolTable` filters the loaded secret bag through this set on every
 * `execute()` call so a tool only ever sees the secrets it declared.
 */
export interface ToolEntry {
  tool: Tool;
  allowedSecrets: Set<string>;
}

/**
 * Name→Tool registry; the runtime executes through this. The set of
 * tools is fixed after construction except for `addTool()`, used by the
 * SDK to register privileged in-process builtins (spawn_subagent,
 * search_skills) that need a runtime-supplied dep that isn't available
 * at manifest-resolution time. The secrets bag is fixed at construction.
 */
export class ToolTable {
  private readonly byName = new Map<string, ToolEntry>();
  private readonly secrets: Record<string, string>;

  constructor(tools: Array<Tool | ToolEntry>, secrets: Record<string, string>) {
    this.secrets = secrets;
    for (const t of tools) {
      const entry = isToolEntry(t)
        ? t
        : { tool: t, allowedSecrets: new Set<string>() };
      this.byName.set(entry.tool.name, entry);
    }
  }

  list(): ToolDescriptor[] {
    return [...this.byName.values()].map((e) => ({
      name: e.tool.name,
      description: e.tool.description,
      inputSchema: e.tool.inputSchema,
    }));
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /**
   * Register a tool. Two-arg form supplies an explicit allowlist; the
   * one-arg form defaults to no secrets visible (privileged builtins).
   * Returns false if a tool by this name already exists.
   */
  addTool(tool: Tool, allowedSecrets?: Set<string>): boolean {
    if (this.byName.has(tool.name)) return false;
    this.byName.set(tool.name, {
      tool,
      allowedSecrets: allowedSecrets ?? new Set<string>(),
    });
    return true;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const entry = this.byName.get(call.name);
    if (!entry) {
      return {
        content: `Unknown tool: ${call.name}. Available: ${[...this.byName.keys()].join(", ")}`,
        isError: true,
      };
    }
    const filtered = filterSecrets(this.secrets, entry.allowedSecrets);
    try {
      return await entry.tool.execute(call.input, filtered);
    } catch (e) {
      if (e instanceof ToolInputError || e instanceof ToolExecutionError) {
        return { content: (e as Error).message, isError: true };
      }
      throw e;
    }
  }
}

function isToolEntry(v: Tool | ToolEntry): v is ToolEntry {
  return (
    typeof v === "object" && v !== null && "tool" in v && "allowedSecrets" in v
  );
}

function filterSecrets(
  bag: Record<string, string>,
  allow: Set<string>,
): Record<string, string> {
  if (allow.size === 0) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(bag)) {
    if (allow.has(k)) out[k] = v;
  }
  return out;
}
