import * as readline from "node:readline";
import { stdin, stdout, stderr, exit } from "node:process";

import type {
  RunningAgent,
  RunParameters,
  SessionUpdate,
  TurnResult,
} from "../index.js";

import { ansi } from "./markdown.js";
import { StreamingMarkdownRenderer } from "./streaming-markdown.js";
import { wantsColor } from "./term.js";

export interface SlashCommand {
  name: string;
  description: string;
  handler(rest: string): void | Promise<void>;
}

const HISTORY_REPLAY_LINES = 10;

export interface ReplOptions {
  agent: RunningAgent;
  plain?: boolean;
  runParameters?: RunParameters;
  onPrompt?: (text: string) => Promise<TurnResult>;
  banner?: string;
  commands?: SlashCommand[];
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const plain = opts.plain ?? !wantsColor();
  const s = ansiStyle(plain);
  const agent = opts.agent;

  if (opts.banner)
    stdout.write(opts.banner + (opts.banner.endsWith("\n") ? "" : "\n"));

  const printer = startPrinter(agent, plain);

  {
    const all = (await agent.session.pull?.([])) ?? [];
    const tail = all.slice(-HISTORY_REPLAY_LINES);
    if (tail.length > 0) {
      stdout.write(
        `${s.dim}─── resumed: showing last ${tail.length} of ${all.length} events ───${s.reset}\n`,
      );
      printer.replay(tail);
      stdout.write(`${s.dim}─── end of prior session ───${s.reset}\n\n`);
    }
  }

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
      name: "audit",
      description: "print the static capability tree",
      handler: async () => {
        const { auditAgent, formatCapabilityTree } =
          await import("../audit/audit.js");
        const tree = await auditAgent(agent.manifest);
        stdout.write(formatCapabilityTree(tree) + "\n");
      },
    },
    {
      name: "events",
      description: "dump the last N events of the session (default 20)",
      handler: async (rest) => {
        const n = parseInt(rest.trim(), 10);
        const limit = Number.isFinite(n) && n > 0 ? n : 20;
        const all = (await agent.session.pull?.([])) ?? [];
        const tail = all.slice(-limit);
        stdout.write(
          `${s.dim}── last ${tail.length} of ${all.length} events ──${s.reset}\n`,
        );
        printer.replay(tail);
        stdout.write(`${s.dim}── end ──${s.reset}\n`);
      },
    },
    {
      name: "tools",
      description: "list the tool table",
      handler: () => {
        const tools = agent.agentState.toolTable.list();
        if (tools.length === 0) {
          stdout.write(`${s.dim}(no tools)${s.reset}\n`);
          return;
        }
        for (const t of tools) {
          stdout.write(
            `  ${s.cyan}${t.name}${s.reset} ${s.dim}— ${t.description}${s.reset}\n`,
          );
        }
      },
    },
  ];
  const commandTable = new Map<string, SlashCommand>();
  for (const c of builtins) commandTable.set(c.name, c);
  for (const c of opts.commands ?? []) commandTable.set(c.name, c);

  const completer = (line: string): [string[], string] => {
    if (!line.startsWith("/")) return [[], line];
    const partial = line.slice(1).toLowerCase();
    const all = [...commandTable.keys()].sort();
    const hits = all.filter((n) => n.startsWith(partial)).map((n) => "/" + n);
    return [hits.length > 0 ? hits : all.map((n) => "/" + n), line];
  };

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    prompt: buildPrompt(printer.getUsage(), plain),
    terminal: stdout.isTTY,
    completer,
  });

  let inFlight = false;
  let cancelling = false;

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

    try {
      inFlight = true;
      const result = opts.onPrompt
        ? await opts.onPrompt(text)
        : await agent.prompt(text, opts.runParameters);
      if (result.stopReason === "error") {
        const msg = result.error?.message ?? "agent error";
        stderr.write(`${s.red}error:${s.reset} ${msg}\n`);
      } else if (result.stopReason !== "end_turn") {
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

interface Printer {
  stop(): void;
  getUsage(): { used: number; size: number } | null;
  replay(updates: Iterable<SessionUpdate>): void;
}

interface PendingCall {
  title: string;
  input: unknown;
}

function startPrinter(agent: RunningAgent, plain: boolean): Printer {
  const s = ansiStyle(plain);
  let md = new StreamingMarkdownRenderer({ plain });
  let inAgentMessage = false;
  let lastUsage: { used: number; size: number } | null = null;
  const stopFlag = { current: false };

  const pendingCalls = new Map<string, PendingCall>();

  const finishMessage = (): void => {
    if (inAgentMessage) {
      stdout.write(md.flush());
      stdout.write("\n");
      inAgentMessage = false;
      md = new StreamingMarkdownRenderer({ plain });
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
        stdout.write(md.feed(u.content.text));
        break;
      }
      case "agent_thought_chunk": {
        if (u.content.type !== "text") return;
        stdout.write(`${s.gray}thought: ${u.content.text}${s.reset}\n`);
        break;
      }
      case "tool_call": {
        finishMessage();
        pendingCalls.set(u.toolCallId, {
          title: u.title,
          input: u.rawInput,
        });
        break;
      }
      case "tool_call_update": {
        const status = u.status ?? "?";
        if (status !== "completed" && status !== "failed") {
          break;
        }
        const call = pendingCalls.get(u.toolCallId);
        pendingCalls.delete(u.toolCallId);

        const title = call?.title ?? u.title ?? "tool";
        const argsStr = call ? renderArgs(call.input) : "";
        const callLine = `${s.cyan}⏺${s.reset} ${s.bold}${title}${s.reset}${
          argsStr ? `${s.dim}(${s.reset}${argsStr}${s.dim})${s.reset}` : ""
        }`;
        stdout.write(callLine + "\n");

        const text = (u.content ?? [])
          .map((c) =>
            c.type === "content" && c.content.type === "text"
              ? c.content.text
              : "",
          )
          .join("");
        const summary = oneLine(text, 200);
        const icon = status === "completed" ? "✓" : "✗";
        const color = status === "failed" ? s.red : s.green;
        const result = summary
          ? `${color}⎿${s.reset} ${color}${icon}${s.reset} ${s.dim}${summary}${s.reset}`
          : `${color}⎿${s.reset} ${color}${icon} ${status}${s.reset}`;
        stdout.write(`  ${result}\n`);
        break;
      }
      case "stop": {
        finishMessage();
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
      finishMessage();
    },
    getUsage: () => lastUsage,
    replay: (updates) => {
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
      finishMessage();
    },
  };
}

function renderArgs(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "object") return formatScalar(input);
  if (Array.isArray(input)) return JSON.stringify(input).slice(0, 80);
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return "";
  if (keys.length === 1) {
    const [firstKey] = keys as [string];
    return formatScalar(obj[firstKey]);
  }
  return keys.map((k) => `${k}=${formatScalar(obj[k])}`).join(", ");
}

function formatScalar(v: unknown): string {
  if (typeof v === "string") {
    if (v.length > 60) return JSON.stringify(v.slice(0, 57) + "…");
    return JSON.stringify(v);
  }
  if (v === null || v === undefined) return "";
  return JSON.stringify(v);
}

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

function oneLine(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max - 1) + "…" : collapsed;
}

type Style = typeof ansi;
function ansiStyle(plain: boolean): Style {
  if (!plain) return ansi;
  const empty = {} as Style;
  for (const k of Object.keys(ansi) as (keyof Style)[]) empty[k] = "";
  return empty;
}
