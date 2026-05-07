/**
 * `bash` — execute a shell command via `/bin/bash -c`.
 *
 * Capabilities: none — the tool itself imposes no constraints. This is
 * the canonical "trust your tools" example: bash can do anything the
 * loom process can. Run it only inside an environment you've already
 * decided is acceptable.
 *
 * Future: a sandboxed bash variant ships its own container/seccomp
 * setup. For now this is the un-sandboxed version.
 */

import { spawn } from "node:child_process";

import type {
  Tool,
  ToolConfig,
  ToolContext,
  ToolResult,
} from "../../types/interfaces.js";
import type { JSONSchema } from "../../types/schema.js";

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
  public readonly description =
    "Execute a bash command. Returns stdout (or stderr on failure).";
  public readonly inputSchema = SCHEMA;
  public readonly capabilities: Record<string, unknown>;

  constructor(config: ToolConfig) {
    if (typeof config === "string") {
      this.capabilities = {};
    } else {
      const c = config as { capabilities?: unknown };
      this.capabilities = (c.capabilities as Record<string, unknown>) ?? {};
    }
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

    return await new Promise<ToolResult>((resolve) => {
      const child = spawn("/bin/bash", ["-c", i.command as string], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout);

      const onAbort = () => {
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
