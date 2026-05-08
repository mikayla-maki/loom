#!/usr/bin/env node
/**
 * loom-sample-cli — the testbed CLI agent.
 *
 * A minimal interactive agent that exercises the full Loom stack via the
 * public SDK:
 *   - Inline AgentManifest construction (no agent.toml on disk).
 *   - Anthropic harness for the model loop.
 *   - Compacting session for long-running conversations.
 *   - Markdown rendering of agent output and tool-call summaries.
 *
 * Usage: ANTHROPIC_API_KEY=... loom-sample-cli
 *
 * Flags:
 *   --model <id>           override the Claude model id
 *   --no-tools             disable the default builtin tool set
 *   --compact-after <n>    compact when the session exceeds <n> events
 *   --plain                disable ANSI styling
 *
 * The CLI itself owns no agent primitives; it wires harness + session +
 * tools (all from loom) together with a small REPL loop.
 */

import * as readline from "node:readline";
import { stdin, stdout, stderr, exit } from "node:process";

import {
  runAgent,
  CompactingSession,
  modelCompactor,
  type RunningAgent,
  type SessionUpdate,
  type AgentManifest,
} from "loom";

import { renderMarkdown, ansi } from "./markdown.js";

interface Args {
  model: string;
  noTools: boolean;
  compactAfter: number;
  plain: boolean;
  modelCompact: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    model: "claude-3-5-sonnet-latest",
    noTools: false,
    compactAfter: 40,
    plain: !stdout.isTTY,
    modelCompact: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") out.model = argv[++i] ?? out.model;
    else if (a === "--no-tools") out.noTools = true;
    else if (a === "--compact-after") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) out.compactAfter = n;
    } else if (a === "--plain") out.plain = true;
    else if (a === "--model-compact") out.modelCompact = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      exit(0);
    }
  }
  return out;
}

function printHelp(): void {
  stdout.write(
    `loom-sample-cli — interactive Loom testbed\n\n` +
      `Usage: loom-sample-cli [options]\n\n` +
      `Options:\n` +
      `  --model <id>           Claude model id (default: claude-3-5-sonnet-latest)\n` +
      `  --no-tools             disable the default builtin tools\n` +
      `  --compact-after <n>    compact when session exceeds <n> events (default: 40)\n` +
      `  --model-compact        use the model to write compaction summaries\n` +
      `  --plain                disable ANSI styling\n` +
      `  -h, --help             this help\n\n` +
      `Environment:\n` +
      `  ANTHROPIC_API_KEY      required\n`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.ANTHROPIC_API_KEY) {
    stderr.write(
      `${ansiStyle(args.plain).red}error:${ansiStyle(args.plain).reset} ANTHROPIC_API_KEY is not set.\n` +
        `Set it in your shell, e.g.:\n  export ANTHROPIC_API_KEY=sk-ant-...\n`,
    );
    exit(2);
  }

  const manifest: AgentManifest = {
    name: "sample-cli",
    description: "A small interactive agent for poking at Loom.",
    systemPrompt:
      "You are a helpful assistant running inside a small terminal CLI. " +
      "Keep replies focused and use markdown formatting (headings, lists, " +
      "code fences) when it improves readability.",
    harness: {
      provider: "anthropic",
      model: args.model,
    },
    // Inline session instance: heuristic compactor by default; opt into
    // model-driven summarisation with --model-compact (which uses the
    // SessionRuntime adapter loom binds at boot).
    session: new CompactingSession({
      threshold: args.compactAfter,
      keep: Math.max(4, Math.floor(args.compactAfter / 4)),
      ...(args.modelCompact ? { compactor: modelCompactor() } : {}),
    }),
    ...(args.noTools ? { tools: {} } : {}),
  };

  let agent: RunningAgent;
  try {
    agent = await runAgent(manifest);
  } catch (e) {
    stderr.write(
      `${ansiStyle(args.plain).red}failed to start agent:${ansiStyle(args.plain).reset}\n${(e as Error).message}\n`,
    );
    exit(1);
  }

  // The CompactingSession received a SessionRuntime via bindRuntime
  // during runAgent(); when --model-compact is set the modelCompactor
  // closes over it and drives a model turn for summarisation. See
  // internal-docs/session-notes.md for the design discussion.

  printBanner(agent, args);

  // Subscribe to updates; render them as they arrive.
  const printer = startPrinter(agent, args);

  // REPL.
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    prompt: args.plain
      ? "you> "
      : `${ansi.bold}${ansi.green}you›${ansi.reset} `,
    terminal: stdout.isTTY,
  });

  let cancelling = false;
  rl.on("SIGINT", () => {
    if (cancelling) {
      stderr.write("\n(force quit)\n");
      exit(130);
    }
    cancelling = true;
    stderr.write("\n(cancelling turn… ctrl-c again to exit)\n");
    void agent.cancel().finally(() => {
      cancelling = false;
      rl.prompt();
    });
  });

  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      continue;
    }
    if (text === "/quit" || text === "/exit") break;
    if (text === "/events") {
      const events = await agent.session.getEvents();
      stdout.write(
        `${ansi.dim}(${events.length} events in session)${ansi.reset}\n`,
      );
      rl.prompt();
      continue;
    }
    try {
      const stop = await agent.prompt(text);
      if (stop !== "end_turn") {
        stdout.write(`${ansi.dim}(stopped: ${stop})${ansi.reset}\n`);
      }
    } catch (e) {
      stderr.write(`${ansi.red}error:${ansi.reset} ${(e as Error).message}\n`);
    }
    rl.prompt();
  }

  await agent.close();
  printer.stop();
}

function printBanner(_agent: RunningAgent, args: Args): void {
  const s = ansiStyle(args.plain);
  const lines = [
    `${s.bold}${s.cyan}loom${s.reset} ${s.dim}sample cli${s.reset}`,
    `${s.dim}model:${s.reset} ${args.model}    ${s.dim}compact-after:${s.reset} ${args.compactAfter}`,
    `${s.dim}commands:${s.reset} /quit    /events`,
    "",
  ];
  stdout.write(lines.join("\n"));
}

interface Printer {
  stop(): void;
}

/**
 * Subscribe to the agent's update stream and render incrementally.
 *
 * Each agent_message_chunk is buffered until we hit a logical break
 * (newline, end-of-turn) and rendered as markdown. Tool calls render as
 * a one-line summary; results render dimmed.
 */
function startPrinter(agent: RunningAgent, args: Args): Printer {
  const s = ansiStyle(args.plain);
  let buffer = "";
  let inAgentMessage = false;
  const stopFlag = { current: false };

  const flush = (final: boolean): void => {
    if (!buffer) return;
    if (final) {
      stdout.write(renderMarkdown(buffer, { plain: args.plain }));
      stdout.write("\n");
      buffer = "";
      return;
    }
    // Flush whole lines we've accumulated.
    const idx = buffer.lastIndexOf("\n");
    if (idx >= 0) {
      const ready = buffer.slice(0, idx + 1);
      buffer = buffer.slice(idx + 1);
      stdout.write(renderMarkdown(ready, { plain: args.plain }));
    }
  };

  void (async () => {
    for await (const u of agent.updates()) {
      if (stopFlag.current) break;
      handleUpdate(u, s);
    }
  })();

  function handleUpdate(
    u: SessionUpdate,
    s: ReturnType<typeof ansiStyle>,
  ): void {
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
        const inputPreview = previewJson(u.input);
        stdout.write(
          `${s.yellow}↪ ${u.title}${s.reset} ${s.dim}${inputPreview}${s.reset}\n`,
        );
        break;
      }
      case "tool_call_update": {
        const status = u.status ?? "?";
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
          `  ${color}${status}${s.reset}${summary ? ` ${s.dim}${summary}${s.reset}` : ""}\n`,
        );
        break;
      }
      case "stop": {
        flush(true);
        inAgentMessage = false;
        break;
      }
      case "user_message_chunk":
      case "plan":
        // user message we already echoed; plans aren't surfaced.
        break;
    }
  }

  return {
    stop: () => {
      stopFlag.current = true;
      flush(true);
    },
  };
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

interface Style {
  reset: string;
  bold: string;
  dim: string;
  cyan: string;
  yellow: string;
  magenta: string;
  green: string;
  red: string;
  gray: string;
}

function ansiStyle(plain: boolean): Style {
  if (plain) {
    return {
      reset: "",
      bold: "",
      dim: "",
      cyan: "",
      yellow: "",
      magenta: "",
      green: "",
      red: "",
      gray: "",
    };
  }
  return {
    reset: ansi.reset,
    bold: ansi.bold,
    dim: ansi.dim,
    cyan: ansi.cyan,
    yellow: ansi.yellow,
    magenta: ansi.magenta,
    green: ansi.green,
    red: ansi.red,
    gray: ansi.gray,
  };
}

main().catch((e) => {
  stderr.write(`${(e as Error).stack ?? e}\n`);
  exit(1);
});
