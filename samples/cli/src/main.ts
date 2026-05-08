#!/usr/bin/env node
/**
 * loom-sample-cli — entrypoint.
 *
 * Assembles the agent runtime (harness + session + tools) and hands a
 * `RunningAgent` to the CLI module. Nothing in here knows about
 * readline, ANSI codes, or update streams — that all lives in
 * `cli.ts`. The split is deliberate: it shows that Loom is a library
 * of composable parts, and that a client is just glue around the
 * `RunningAgent` API.
 *
 * Usage: ANTHROPIC_API_KEY=... loom-sample-cli [flags]
 *
 * Flags:
 *   --model <id>           override the Claude model id
 *   --effort <level>       low | medium | high | xhigh | max
 *   --no-tools             disable the default builtin tool set
 *   --compact-after <n>    compact when the session exceeds <n> events
 *   --model-compact        use the model to write compaction summaries
 *   --session <path>       JSONL session log file (default: ./sample-cli-session.jsonl)
 *   --fresh                delete the session file before starting (no resume)
 *   --plain                disable ANSI styling
 */

import { stdout, stderr, exit } from "node:process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  runAgent,
  CompactingSession,
  FileSession,
  modelCompactor,
  AnthropicHarness,
  type AgentManifest,
  type RunParameters,
} from "loom";

import { runCli, type SlashCommand } from "./cli.js";
import { ansi } from "./markdown.js";

// ─── main: assemble + run ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.ANTHROPIC_API_KEY) {
    stderr.write(
      `${args.plain ? "" : ansi.red}error:${args.plain ? "" : ansi.reset} ANTHROPIC_API_KEY is not set.\n` +
        `Set it in your shell, e.g.:\n  export ANTHROPIC_API_KEY=sk-ant-...\n`,
    );
    exit(2);
  }

  // Construct the primitives ourselves rather than handing the manifest
  // a `{ provider: "anthropic" }` config. We hold direct references so
  // the `/compact` slash command can drive `session.compactNow(harness)`.
  const harness = new AnthropicHarness(
    args.model,
    process.env.ANTHROPIC_API_KEY,
    "https://api.anthropic.com",
    4096,
    16,
    true, // streaming
  );

  // File-backed session. FileSession loads existing events from the
  // JSONL log on first pull; on next launch with the same path, the
  // prior conversation comes back in context. Wrapped in
  // CompactingSession so long-running sessions don't blow the model's
  // context window.
  const sessionPath = path.resolve(args.sessionPath);
  if (args.fresh) {
    try {
      fs.unlinkSync(sessionPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const priorEventCount = countSessionEvents(sessionPath);
  const session = new CompactingSession(new FileSession(sessionPath), {
    threshold: args.compactAfter,
    keep: Math.max(4, Math.floor(args.compactAfter / 4)),
    ...(args.modelCompact ? { compactor: modelCompactor() } : {}),
  });

  const manifest: AgentManifest = {
    name: "sample-cli",
    description: "A small interactive agent for poking at Loom.",
    systemPrompt:
      "You are a helpful assistant running inside a small terminal CLI. " +
      "Keep replies focused and use markdown formatting (headings, lists, " +
      "code fences) when it improves readability.",
    harness, // ← instance, not config
    session, // ← instance
    ...(args.noTools ? { tools: {} } : {}),
  };

  const agent = await runAgent(manifest);

  // Custom slash command. The CLI ships /quit, /exit, /help, /events
  // built-in; everything else is the client's to add. /compact is the
  // demonstration: it closes over the harness + session refs we own
  // here and drives `compactNow()` directly.
  const compactCommand: SlashCommand = {
    name: "compact",
    description: "force a compaction pass right now",
    handler: async () => {
      const result = await session.compactNow(harness);
      if (result) {
        stdout.write(
          `${ansi.dim}(compacted: ${result.before} → ${result.after} events)${ansi.reset}\n`,
        );
      } else {
        stdout.write(`${ansi.dim}(nothing to compact)${ansi.reset}\n`);
      }
    },
  };

  const params: RunParameters = {};
  if (args.effort) params.effort = args.effort;

  try {
    await runCli({
      agent,
      plain: args.plain,
      banner: buildBanner(args, sessionPath, priorEventCount),
      commands: [compactCommand],
      // Wire the prompt path explicitly. The CLI hands us each line
      // of user input; we drive `agent.prompt` ourselves. Same as
      // the default, just spelled out so it's clear that prompting
      // is one function call.
      onPrompt: (text) => agent.prompt(text, params),
    });
  } finally {
    await agent.close();
  }
}

main().catch((e) => {
  stderr.write(`${(e as Error).stack ?? e}\n`);
  exit(1);
});

// ─── helpers (arg parsing, help text, banner) ───────────────────────────────

interface Args {
  model: string;
  noTools: boolean;
  compactAfter: number;
  plain: boolean;
  modelCompact: boolean;
  effort: RunParameters["effort"] | undefined;
  sessionPath: string;
  fresh: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    model: "claude-sonnet-4-5",
    noTools: false,
    compactAfter: 40,
    plain: !stdout.isTTY,
    modelCompact: false,
    effort: undefined,
    sessionPath: "./sample-cli-session.jsonl",
    fresh: false,
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
    else if (a === "--session") {
      out.sessionPath = argv[++i] ?? out.sessionPath;
    } else if (a === "--fresh") out.fresh = true;
    else if (a === "--effort") {
      const v = argv[++i];
      if (
        v === "low" ||
        v === "medium" ||
        v === "high" ||
        v === "xhigh" ||
        v === "max"
      ) {
        out.effort = v;
      } else {
        stderr.write(`unknown --effort value: ${v}\n`);
        exit(2);
      }
    } else if (a === "--help" || a === "-h") {
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
      `  --model <id>           Claude model id (default: claude-sonnet-4-5)\n` +
      `  --effort <level>       low | medium | high | xhigh | max (default: model decides)\n` +
      `  --no-tools             disable the default builtin tools\n` +
      `  --compact-after <n>    compact when session exceeds <n> events (default: 40)\n` +
      `  --model-compact        use the model to write compaction summaries\n` +
      `  --session <path>       JSONL session log (default: ./sample-cli-session.jsonl)\n` +
      `  --fresh                delete the session file before starting (no resume)\n` +
      `  --plain                disable ANSI styling\n` +
      `  -h, --help             this help\n\n` +
      `Environment:\n` +
      `  ANTHROPIC_API_KEY      required\n`,
  );
}

function buildBanner(
  args: Args,
  sessionPath: string,
  priorEvents: number,
): string {
  const sessionLine =
    priorEvents > 0
      ? `session: ${sessionPath} (resumed, ${priorEvents} events)`
      : `session: ${sessionPath} (new)`;
  if (args.plain) {
    return (
      `loom sample cli\n` +
      `model: ${args.model}    compact-after: ${args.compactAfter}\n` +
      `${sessionLine}\n` +
      `commands: /quit  /exit  /help  /events  /compact\n`
    );
  }
  return (
    `${ansi.bold}${ansi.cyan}loom${ansi.reset} ${ansi.dim}sample cli${ansi.reset}\n` +
    `${ansi.dim}model:${ansi.reset} ${args.model}    ${ansi.dim}compact-after:${ansi.reset} ${args.compactAfter}\n` +
    `${ansi.dim}${sessionLine}${ansi.reset}\n` +
    `${ansi.dim}commands:${ansi.reset} /quit  /exit  /help  /events  /compact\n`
  );
}

/**
 * Count events in a JSONL session file without parsing them. Used
 * only for the resume banner; if the file is missing or unreadable
 * we report 0 (a fresh session).
 */
function countSessionEvents(filePath: string): number {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return text.split("\n").filter((l) => l.length > 0).length;
  } catch {
    return 0;
  }
}
