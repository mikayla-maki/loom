/**
 * Simple line-based renderer — prints session updates to stdout in plain text.
 *
 * The renderer is split out so it can be reused by the CLI, ACP smoke tests,
 */

import type { SessionUpdate } from "../types/acp.js";
import { wantsColor } from "./term.js";

export interface RendererOptions {
  out?: NodeJS.WritableStream;
  /** Override colour detection. Defaults to `COLORTERM`-driven. */
  useColors?: boolean;
}

const ANSI = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
};

export class TextRenderer {
  private readonly out: NodeJS.WritableStream;
  private readonly colors: boolean;
  private lastKind: string | null = null;

  constructor(options: RendererOptions = {}) {
    this.out = options.out ?? process.stdout;
    this.colors = options.useColors ?? wantsColor();
  }

  render(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        if (update.content.type === "text") {
          this.line("user", update.content.text, ANSI.bold);
        }
        break;
      case "agent_message_chunk":
        if (update.content.type === "text") {
          this.line("agent", update.content.text, ANSI.cyan);
        }
        break;
      case "agent_thought_chunk":
        if (update.content.type === "text") {
          this.line("thought", update.content.text, ANSI.dim);
        }
        break;
      case "tool_call":
        this.line(
          "tool",
          `${update.title} ${this.briefJson(update.rawInput)}`,
          ANSI.yellow,
        );
        break;
      case "tool_call_update": {
        const status = update.status ?? "";
        const text =
          (update.content ?? [])
            .map((c) =>
              c.type === "content" && c.content.type === "text"
                ? c.content.text
                : "",
            )
            .join("")
            .trim() || "(no output)";
        const color = update.status === "failed" ? ANSI.red : ANSI.green;
        this.line(`tool/${status}`, this.truncate(text, 800), color);
        break;
      }
      case "stop":
        this.line("stop", update.stopReason, ANSI.dim);
        break;
      case "plan":
        for (const e of update.entries) {
          this.line("plan", e.content, ANSI.dim);
        }
        break;
    }
  }

  private line(label: string, text: string, color: string): void {
    const tag = this.colors ? `${color}[${label}]${ANSI.reset}` : `[${label}]`;
    if (this.lastKind !== label) {
      this.out.write("\n");
    }
    this.out.write(`${tag} ${text}\n`);
    this.lastKind = label;
  }

  private briefJson(v: unknown): string {
    if (v === undefined) return "";
    try {
      const s = JSON.stringify(v);
      return this.truncate(s ?? "", 200);
    } catch {
      return "";
    }
  }

  private truncate(s: string, n: number): string {
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + "…";
  }
}
