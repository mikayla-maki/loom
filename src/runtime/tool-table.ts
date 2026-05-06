/**
 * Tool table — the runtime-side registry of tools available to the harness,
 * plus the executor that turns a `ToolCall` into a process invocation.
 *
 * Process model (v0):
 *   - input  → JSON on stdin
 *   - output → string on stdout (last process exit code 0)
 *   - error  → string on stderr (exit code != 0 → ToolExecutionError)
 *   - secrets → env vars (uppercased + GLASS_-prefixed; never visible to model)
 *
 * Capability declarations are the input to v1 OS-level enforcement; in v0
 * we already validate them at boot time in the resolver.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";

import Ajv from "ajv";

import { ToolExecutionError, ToolInputError } from "../errors.js";
import type { Tool, ToolCall, ToolDescriptor, ToolResult } from "../types/interfaces.js";
import type { ToolManifest } from "../types/manifest.js";
import type { SecretsStore } from "./secrets.js";

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });

export interface ProcessToolOptions {
  /** Extra env vars merged into every tool process. */
  env?: Record<string, string>;
  /** Working directory for tool processes. Defaults to the tool's directory. */
  cwd?: string;
  /** PATH additions (each tool's bin/ if shipsBinary). */
  extraPath?: string[];
  /** Per-tool execution timeout in ms (0 = no timeout). */
  timeoutMs?: number;
}

/** A Tool implementation backed by a child-process invocation. */
export class ProcessTool implements Tool {
  public readonly name: string;
  public readonly description: string;
  public readonly inputSchema: ToolManifest["tool"]["schema"];
  private readonly validate: import("ajv").ValidateFunction;

  constructor(
    public readonly manifest: ToolManifest,
    private readonly options: ProcessToolOptions = {},
  ) {
    this.name = manifest.tool.name;
    this.description = manifest.tool.description;
    this.inputSchema = manifest.tool.schema;
    try {
      this.validate = ajv.compile(this.inputSchema as object);
    } catch (e) {
      throw new ToolInputError(
        `Invalid JSON schema for tool '${this.name}': ${(e as Error).message}`,
        { cause: e },
      );
    }
  }

  async execute(input: unknown, secrets: Record<string, string>): Promise<ToolResult> {
    if (!this.validate(input)) {
      const errors = (this.validate.errors ?? [])
        .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`)
        .join("; ");
      throw new ToolInputError(`Tool '${this.name}' input failed validation: ${errors}`);
    }

    const env = this.buildEnv(secrets);
    const cwd = this.options.cwd ?? this.manifest.toolDir;
    const command = this.manifest.tool.invocation.command;
    const args = this.manifest.tool.invocation.args ?? [];

    return new Promise<ToolResult>((resolve, reject) => {
      const child = spawn(command, args, {
        env,
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;
      const timeout = this.options.timeoutMs ?? 0;
      if (timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeout);
      }

      child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
      child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
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
          // Non-zero: surface stderr + stdout into the tool result rather than
          // throwing, so the model can see what went wrong and adapt. The
          // harness can decide whether to keep going.
          resolve({
            content: stderr || stdout || `tool '${this.name}' exited with code ${code}`,
            isError: true,
          });
        }
      });

      child.stdin.end(JSON.stringify(input));
    });
  }

  private buildEnv(secrets: Record<string, string>): NodeJS.ProcessEnv {
    /**
     * Tool env model:
     *  - Start from a small system whitelist (PATH, locale, HOME, NODE_*).
     *  - Add ONLY the secrets this tool declared (under the original name +
     *    upper-snake alias).
     *  - Optional explicit env from ProcessToolOptions.env wins over the above.
     *
     * Why: parent process env can contain unrelated API keys / credentials
     * we never want a tool to see (this is the v0 take on "every scope is
     * sandboxed by default; tools are the only mechanism that grants
     * capability"). v1 OS-level enforcement layers atop this; v0's defense
     * is at the env boundary.
     */
    const SYSTEM_WHITELIST = [
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
    ];
    const base: NodeJS.ProcessEnv = {};
    for (const key of SYSTEM_WHITELIST) {
      const v = process.env[key];
      if (typeof v === "string") base[key] = v;
    }
    // PATH (whitelisted + extensions)
    const extra = this.options.extraPath ?? [];
    base.PATH = [...extra, process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"]
      .filter(Boolean)
      .join(path.delimiter);

    // Declared secrets only.
    const requested = new Set([
      ...this.manifest.tool.secrets.required,
      ...(this.manifest.tool.secrets.optional ?? []),
    ]);
    for (const [name, value] of Object.entries(secrets)) {
      if (!requested.has(name)) continue;
      base[name] = value;
      base[name.replace(/[.\-]/g, "_").toUpperCase()] = value;
    }

    // Special: the builtin `secrets.get` tool exposes all loaded agent secrets
    // as a JSON-encoded env var so the model can request them by name. This
    // is gated by the tool's name (only set for the builtin; users can't
    // recreate it under a different name). The agent's [sandbox].secrets
    // ceiling already bounded what's loaded.
    if (this.manifest.tool.name === "secrets.get") {
      base.GLASS_SECRETS_JSON = JSON.stringify(secrets);
    }

    // Caller overrides last — useful for tests.
    if (this.options.env) {
      Object.assign(base, this.options.env);
    }

    base.GLASS_TOOL_NAME = this.name;
    return base;
  }
}

/** Holds a name→Tool map and an executor. */
export class ToolTable {
  private readonly byName = new Map<string, Tool>();
  constructor(
    tools: Tool[],
    private readonly secrets: Record<string, string>,
  ) {
    for (const t of tools) {
      this.byName.set(t.name, t);
    }
  }

  list(): ToolDescriptor[] {
    return Array.from(this.byName.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const t = this.byName.get(call.name);
    if (!t) {
      return {
        content: `Unknown tool: ${call.name}. Available: ${Array.from(this.byName.keys()).join(", ")}`,
        isError: true,
      };
    }
    try {
      return await t.execute(call.input, this.secrets);
    } catch (e) {
      if (e instanceof ToolInputError) {
        return { content: (e as Error).message, isError: true };
      }
      if (e instanceof ToolExecutionError) {
        return { content: (e as Error).message, isError: true };
      }
      throw e;
    }
  }
}
