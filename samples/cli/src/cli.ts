/**
 * cli.ts — the REPL.
 *
 * Knows nothing about which harness or session powers the agent. Takes
 * a `RunningAgent` and runs a turn-based chat against it, with
 * incremental rendering of `SessionUpdate`s and a slash-command API
 * for clients that want to extend the interaction surface.
 *
 * The point is to show how cleanly Loom separates the agent runtime
 * from the client UI: the assembly of harness + session + tools
 * happens in `main.ts`; everything in this file just consumes the
 * public `RunningAgent` API.
 */

import * as readline from "node:readline";
import { stdin, stdout, stderr, exit } from "node:process";

import type {
  RunningAgent,
  RunParameters,
  SessionUpdate,
  TurnResult,
} from "loom";

import { renderMarkdown, ansi } from "./markdown.js";

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * A custom slash command. Clients register these via {@link CliOptions.commands}
 * to extend the REPL with operations that act on resources outside the
 * `RunningAgent` (e.g. a held session reference for `/compact`).
 */
export interface SlashCommand {
  /** Command name without the leading slash. */
  name: string;
  /** Short description shown by `/help`. */
  description: string;
  /**
   * Invoked when the user types `/<name> [rest]`. `rest` is the input
   * after the command name (may be empty). The handler may print to
   * stdout and may be async; the REPL re-prompts after it resolves.
   */
  handler(rest: string): void | Promise<void>;
}

export interface CliOptions {
  agent: RunningAgent;
  /** Disable ANSI styling. Defaults to !stdout.isTTY. */
  plain?: boolean;
  /**
   * Per-turn run parameters applied to every prompt (effort, thinking,
   * etc.). Clients can also expose a `/effort` command and rotate it.
   *
   * Ignored if `onPrompt` is supplied — the consumer drives the
   * prompt call themselves.
   */
  runParameters?: RunParameters;
  /**
   * Optional override for the prompt path. Called with the user's
   * raw input text whenever they hit enter on a non-slash line.
   * Returns a `TurnResult` (same shape as `agent.prompt`) so the
   * REPL can render the stop reason uniformly. Default when
   * undefined: `(text) => agent.prompt(text, runParameters)`.
   *
   * Useful for pre/post-processing the prompt, switching models
   * mid-session based on input, recording prompts to a separate
   * log, etc.
   */
  onPrompt?: (text: string) => Promise<TurnResult>;
  /** Banner printed at startup. Multi-line strings are fine. */
  banner?: string;
  /**
   * On startup, replay the last N events of the session through the
   * normal renderer so the user sees recent context when resuming.
   * Default: 10 events. Set to 0 to disable. The replay is read-only
   * — it pulls from `agent.session.pull` and renders, no events are
   * generated.
   */
  historyLines?: number;
  /** Custom slash commands. `/quit`, `/exit`, `/help`, `/events` are built in. */
  commands?: SlashCommand[];
}

/**
 * Run the REPL. Returns when the user quits (`/quit`, `/exit`, Ctrl-D,
 * or Ctrl-C at idle). The agent is NOT closed here — caller owns
 * lifecycle.
 */
export async function runCli(opts: CliOptions): Promise<void> {
  const plain = opts.plain ?? !stdout.isTTY;
  const s = ansiStyle(plain);
  const agent = opts.agent;

  if (opts.banner)
    stdout.write(opts.banner + (opts.banner.endsWith("\n") ? "" : "\n"));

  const printer = startPrinter(agent, plain);

  // Resume hint: replay the last N events of the session so the user
  // sees the conversational tail when reopening a persisted session.
  // No-ops on a fresh session.
  const historyLines = opts.historyLines ?? 10;
  if (historyLines > 0) {
    const all = (await agent.session.pull?.([])) ?? [];
    const tail = all.slice(-historyLines);
    if (tail.length > 0) {
      stdout.write(
        `${s.dim}─── resumed: showing last ${tail.length} of ${all.length} events ───${s.reset}\n`,
      );
      printer.replay(tail);
      stdout.write(`${s.dim}─── end of prior session ───${s.reset}\n\n`);
    }
  }

  // Built-in commands. Custom commands win on name collision.
  const builtins: SlashCommand[] = [
    {
      name: "quit",
      description: "leave the REPL",
      handler: () => {
        rl.close();
      },
    },
    {
      name: "exit",
      description: "leave the REPL",
      handler: () => {
        rl.close();
      },
    },
    {
      name: "help",
      description: "list slash commands",
      handler: () => {
        const all = [...(opts.commands ?? []), ...builtins];
        const seen = new Set<string>();
        const lines: string[] = [];
        for (const c of all) {
          if (seen.has(c.name)) continue;
          seen.add(c.name);
          lines.push(
            `  ${s.dim}/${c.name.padEnd(10)}${s.reset} ${c.description}`,
          );
        }
        stdout.write(lines.join("\n") + "\n");
      },
    },
    {
      name: "events",
      description: "print the current session event count",
      handler: async () => {
        const events = (await agent.session.pull?.([])) ?? [];
        stdout.write(
          `${s.dim}(${events.length} events in session)${s.reset}\n`,
        );
      },
    },
  ];
  const commandTable = new Map<string, SlashCommand>();
  for (const c of builtins) commandTable.set(c.name, c);
  for (const c of opts.commands ?? []) commandTable.set(c.name, c); // overrides

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    prompt: buildPrompt(printer.getUsage(), plain),
    terminal: stdout.isTTY,
  });

  // Turn lifecycle bookkeeping. inFlight flips while a turn runs;
  // cancelling flips when the user has asked to stop a turn.
  let inFlight = false;
  let cancelling = false;

  // Ctrl-C: at idle — exit. Mid-turn — cancel. Mid-cancel — force exit.
  rl.on("SIGINT", () => {
    if (!inFlight) {
      stdout.write("\n");
      rl.close();
      return;
    }
    if (cancelling) {
      stderr.write("\n(force quit)\n");
      exit(130);
    }
    cancelling = true;
    stderr.write("\n(cancelling… ctrl-c again to force quit)\n");
    void agent.cancel();
  });

  // Esc cancels the in-flight turn (silent at idle). readline puts
  // stdin into raw mode while the interface is open and emits
  // `keypress` events; we just listen for escape.
  if (stdin.isTTY) {
    readline.emitKeypressEvents(stdin);
    stdin.on("keypress", (_str, key) => {
      if (key && key.name === "escape" && inFlight && !cancelling) {
        cancelling = true;
        stderr.write("\n(cancelling…)\n");
        void agent.cancel();
      }
    });
  }

  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      continue;
    }

    // Slash commands.
    if (text.startsWith("/")) {
      const space = text.indexOf(" ");
      const name = (
        space < 0 ? text.slice(1) : text.slice(1, space)
      ).toLowerCase();
      const rest = space < 0 ? "" : text.slice(space + 1).trim();
      const cmd = commandTable.get(name);
      if (!cmd) {
        stdout.write(
          `${s.dim}unknown command: /${name} (try /help)${s.reset}\n`,
        );
      } else {
        try {
          await cmd.handler(rest);
        } catch (e) {
          stderr.write(`${s.red}error:${s.reset} ${(e as Error).message}\n`);
        }
      }
      rl.setPrompt(buildPrompt(printer.getUsage(), plain));
      rl.prompt();
      continue;
    }

    // Normal turn.
    try {
      inFlight = true;
      const result = opts.onPrompt
        ? await opts.onPrompt(text)
        : await agent.prompt(text, opts.runParameters);
      if (result.stopReason !== "end_turn") {
        stdout.write(`${s.dim}(stopped: ${result.stopReason})${s.reset}\n`);
      }
    } catch (e) {
      stderr.write(`${s.red}error:${s.reset} ${(e as Error).message}\n`);
    } finally {
      inFlight = false;
      cancelling = false;
    }
    rl.setPrompt(buildPrompt(printer.getUsage(), plain));
    rl.prompt();
  }

  printer.stop();
}

// ────────────────────────────────────────────────────────────────────────────
// Printer — subscribes to agent updates, renders incrementally.
// ────────────────────────────────────────────────────────────────────────────

interface Printer {
  stop(): void;
  /** Latest usage observed via `usage_update`, or null. */
  getUsage(): { used: number; size: number } | null;
  /**
   * Render a sequence of historic events through the same handler used
   * for the live stream. Used by the resume-on-reload banner; safe to
   * call before/after live updates land.
   */
  replay(updates: Iterable<SessionUpdate>): void;
}

function startPrinter(agent: RunningAgent, plain: boolean): Printer {
  const s = ansiStyle(plain);
  let buffer = "";
  let inAgentMessage = false;
  let lastUsage: { used: number; size: number } | null = null;
  const stopFlag = { current: false };
  // Stable short id per toolCallId so paired call/result lines are
  // easy to match visually even when the harness issues several
  // calls in parallel. The model's underlying ids (Anthropic
  // `toolu_01...`, OpenAI `call_...`) are too long to read at a
  // glance; we just hand out 1, 2, 3, ... in order seen.
  const idShorts = new Map<string, string>();
  let nextShort = 1;
  const shortOf = (toolCallId: string): string => {
    let s = idShorts.get(toolCallId);
    if (!s) {
      s = `#${nextShort++}`;
      idShorts.set(toolCallId, s);
    }
    return s;
  };

  const flush = (final: boolean): void => {
    if (!buffer) return;
    if (final) {
      stdout.write(renderMarkdown(buffer, { plain }));
      stdout.write("\n");
      buffer = "";
      return;
    }
    const idx = buffer.lastIndexOf("\n");
    if (idx >= 0) {
      const ready = buffer.slice(0, idx + 1);
      buffer = buffer.slice(idx + 1);
      stdout.write(renderMarkdown(ready, { plain }));
    }
  };

  void (async () => {
    for await (const u of agent.updates()) {
      if (stopFlag.current) break;
      handleUpdate(u);
    }
  })();

  function handleUpdate(u: SessionUpdate): void {
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        if (u.content.type !== "text") return;
        if (!inAgentMessage) {
          inAgentMessage = true;
          stdout.write(`\n${s.bold}${s.magenta}agent›${s.reset} `);
        }
        buffer += u.content.text;
        flush(false);
        break;
      }
      case "agent_thought_chunk": {
        if (u.content.type !== "text") return;
        stdout.write(`${s.gray}thought: ${u.content.text}${s.reset}\n`);
        break;
      }
      case "tool_call": {
        flush(true);
        inAgentMessage = false;
        const tag = shortOf(u.toolCallId);
        const inputPreview = previewJson(u.input);
        stdout.write(
          `${s.yellow}↪ ${tag} ${u.title}${s.reset} ${s.dim}${inputPreview}${s.reset}\n`,
        );
        break;
      }
      case "tool_call_update": {
        const status = u.status ?? "?";
        // Skip non-final updates (status transitions like "in_progress")
        // — the final completed/failed/cancelled is the one worth
        // surfacing. Pending updates without a status are also skipped.
        if (
          status !== "completed" &&
          status !== "failed" &&
          status !== "cancelled"
        ) {
          break;
        }
        const tag = shortOf(u.toolCallId);
        const color = status === "failed" ? s.red : s.green;
        const result = (u.content ?? [])
          .map((c) =>
            c.type === "content" && c.content.type === "text"
              ? c.content.text
              : "",
          )
          .join("");
        const summary = oneLine(result, 200);
        stdout.write(
          `  ${color}${tag} ${status}${s.reset}${summary ? ` ${s.dim}${summary}${s.reset}` : ""}\n`,
        );
        break;
      }
      case "stop": {
        flush(true);
        inAgentMessage = false;
        break;
      }
      case "usage_update": {
        lastUsage = { used: u.used, size: u.size };
        break;
      }
      case "user_message_chunk":
      case "plan":
        break;
    }
  }

  return {
    stop: () => {
      stopFlag.current = true;
      flush(true);
    },
    getUsage: () => lastUsage,
    replay: (updates) => {
      // Drop orphan tool_call_updates whose matching tool_call lies
      // outside the replay window — otherwise the user sees a result
      // line for a call they never saw issued.
      const seenCallIds = new Set<string>();
      for (const u of updates) {
        if (u.sessionUpdate === "tool_call") {
          seenCallIds.add(u.toolCallId);
        } else if (
          u.sessionUpdate === "tool_call_update" &&
          !seenCallIds.has(u.toolCallId)
        ) {
          continue;
        }
        handleUpdate(u);
      }
      flush(true);
      inAgentMessage = false;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build the readline prompt prefix. Includes a context-percentage pip
 * (green/yellow/red) when usage data is available; falls back to the
 * plain `you›` prefix otherwise.
 */
function buildPrompt(
  usage: { used: number; size: number } | null,
  plain: boolean,
): string {
  const s = ansiStyle(plain);
  const base = `${s.bold}${s.green}you›${s.reset} `;
  if (!usage || usage.size <= 0) {
    return plain ? "you> " : base;
  }
  const pct = Math.round((usage.used / usage.size) * 100);
  const color = pct >= 90 ? s.red : pct >= 75 ? s.yellow : s.green;
  return plain ? `[${pct}%] you> ` : `${color}[${pct}%]${s.reset} ${base}`;
}

function previewJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    if (!s) return "";
    return s.length > 80 ? s.slice(0, 77) + "..." : s;
  } catch {
    return "";
  }
}

function oneLine(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max
    ? collapsed.slice(0, max - 3) + "..."
    : collapsed;
}

/**
 * In styled mode return the full `ansi` map; in plain mode return an
 * object with the same keys but empty strings, so caller code stays
 * free of branching.
 */
type Style = typeof ansi;
function ansiStyle(plain: boolean): Style {
  if (!plain) return ansi;
  const empty = {} as Style;
  for (const k of Object.keys(ansi) as (keyof Style)[]) empty[k] = "";
  return empty;
}
