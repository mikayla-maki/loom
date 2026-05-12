#!/usr/bin/env node
/**
 * Loom SDK example — building an agent imperatively, with direct
 * references to specific session layers so you can drive them from
 * your own code.
 *
 * The headline move:
 *
 *     const compactor = new CompactingSession({ ... });
 *     const manifest: AgentManifest = {
 *       ...
 *       session: [
 *         compactor,         // ← a pre-built Session instance
 *         "notes",           // ← a string shorthand, resolved via
 *                            //   [providers].notes
 *         "in-memory",       // ← built-in
 *       ],
 *       ...
 *     };
 *
 * `manifest.session` accepts a heterogeneous array. Each entry is
 * one of:
 *
 *   - a **string** (shorthand for `{ provider: str }` — same as the
 *     TOML `layers = ["compacting", "in-memory"]` inline form)
 *   - a `SessionSpec` (object with `provider` + optional config)
 *   - a pre-built `Session` instance (used verbatim)
 *
 * The runtime resolves the string/spec entries against `[providers]`
 * and the built-in registry, instantiates them, and threads them
 * through `ChainedSession` along with the pre-built instances. Push
 * flows top-to-bottom; pull flows bottom-to-top.
 *
 * Why this matters: it lets you hand-build the layer you want to
 * *control* (here, the compactor, so we can wire `/compact` and
 * `/tokens` slash commands to it) while leaving the layers you don't
 * care about (notes, in-memory storage) to the runtime. With the
 * TOML form there's no handle to call `compactor.compactNow()` on.
 *
 * Run:
 *
 *   ANTHROPIC_API_KEY=... npx tsx examples/sdk-agent/agent.ts
 *   ANTHROPIC_API_KEY=... npx tsx examples/sdk-agent/agent.ts "one-shot prompt"
 *
 * In the REPL:
 *
 *   /tokens     show the most recent `usage_update.used` (= tokens in context)
 *   /compact    force a compaction pass now and print { before, after }
 *   /quit       exit
 */

import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  AnthropicHarness,
  CompactingSession,
  modelCompactor,
  runAgent,
  type AgentManifest,
  type SessionUpdate,
} from "../../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  process.stderr.write("error: set ANTHROPIC_API_KEY before running.\n");
  process.exit(2);
}

// ─── Build the harness as an instance ──────────────────────────────────────
//
// Equivalent to the `[harness]` block in agent.toml, but constructed
// directly. Holding the reference lets us hand the SAME harness to
// both `runAgent` (for the main turn loop) and `modelCompactor`
// (for summary passes), so compaction runs through the same model
// the agent is using — without round-tripping a second config.

const harness = new AnthropicHarness(
  "claude-sonnet-4-5", // model
  apiKey,
  "https://api.anthropic.com", // apiBase
  4096, // maxTokens
  16, // maxTurnRequests
  true, // stream
);

// ─── Build the CompactingSession as an instance ───────────────────────────
//
// This is the layer we want to *drive* from code. Constructed with
// options that have no TOML equivalent (a custom `Compactor` callback
// and an `onCompact` diagnostic hook) and slotted into the session
// chain below by reference.

const compactor = new CompactingSession({
  threshold: 60,
  compactor: modelCompactor(),
  onCompact: ({ before, after }) => {
    process.stdout.write(
      `\n[compacted] ${before} events → ${after} (model-summarised)\n`,
    );
  },
});

// ─── Compose the manifest ─────────────────────────────────────────────────
//
// `session` is a heterogeneous array: the compactor instance is used
// verbatim, the string entries are resolved (against `[providers]`
// for `"notes"`, against the built-in registry for `"in-memory"`)
// and instantiated by the runtime. The result is wrapped in a
// `ChainedSession` outer-to-inner.

const manifest: AgentManifest = {
  // Anchors the relative path in `providers.notes` to this file's
  // directory rather than `process.cwd()`.
  manifestPath: path.join(__dirname, "agent.ts"),
  name: "loom-sdk-demo",
  systemPrompt:
    "You are a helpful assistant who keeps notes across sessions. The " +
    "system prompt includes notes from previous sessions. When the user " +
    "tells you something worth keeping — preferences, project " +
    "conventions, names, recurring context — call the `remember` tool " +
    "with a short declarative fact. Use bash, read_file, write_file, " +
    "edit_file, and find for real work — prefer edit_file over " +
    "write_file for changes to existing files (much more efficient " +
    "and produces a diff for review).",

  providers: {
    notes: { path: "../notes-provider" },
  },

  harness, // ← instance, not spec

  session: [
    compactor, // pre-built CompactingSession (hand-built above)
    "notes", // resolved via [providers].notes
    "in-memory", // built-in storage
  ],

  // `remember` isn't listed here — the notes session contributes it
  // and owns the implementation. The runtime auto-registers it.
  tools: {
    bash: "builtin",
    read_file: "builtin",
    write_file: "builtin",
    edit_file: "builtin",
    find: "builtin",
  },

  capabilities: {
    bash: { subprocess: "*", paths: ["./"] },
    read_file: { paths: ["./"] },
    write_file: { paths: ["./"] },
    edit_file: { paths: ["./"] },
    find: { paths: ["./"] },
    remember: "*",
  },
};

// ─── Drive the agent ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const agent = await runAgent(manifest);

  // Subscribe to updates and render them to stdout. The renderer is
  // intentionally minimal — see `loom run <agent.toml>` for the
  // polished interactive experience (slash commands, streaming
  // markdown, paired tool-call rendering).
  void (async () => {
    for await (const u of agent.updates()) renderUpdate(u);
  })();

  const oneShot = process.argv.slice(2).join(" ").trim();
  if (oneShot) {
    try {
      await agent.prompt(oneShot);
    } finally {
      await agent.close();
    }
    return;
  }

  // Interactive REPL.
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  process.stdout.write(
    "loom-sdk-demo — type /help for commands, /quit to exit.\n",
  );

  try {
    while (true) {
      let line: string;
      try {
        line = await rl.question("> ");
      } catch {
        // readline rejects on close (Ctrl-D).
        break;
      }
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Slash commands are handled here, before we hand the input
      // to the model. The SDK doesn't ship a REPL — `loom run`
      // has its own — so this is just a tiny dispatch table.
      if (trimmed.startsWith("/")) {
        const done = await handleSlashCommand(trimmed);
        if (done) break;
        continue;
      }

      try {
        const result = await agent.prompt(trimmed);
        if (result.stopReason === "error") {
          // Harness signalled a fatal turn error out-of-band; surface it
          // explicitly so it doesn't get lost in the stream.
          process.stderr.write(
            `error: ${result.error?.message ?? "agent error"}\n`,
          );
        } else if (result.stopReason !== "end_turn") {
          process.stdout.write(`[stopped: ${result.stopReason}]\n`);
        }
      } catch (e) {
        process.stderr.write(`error: ${(e as Error).message}\n`);
      }
    }
  } finally {
    rl.close();
    await agent.close();
  }
}

/**
 * Returns `true` when the REPL should exit.
 *
 * These commands are the headline reason to build the agent through
 * the SDK rather than from a manifest: each one reaches into the
 * `compactor` instance we constructed above and slotted into the
 * session chain.
 */
async function handleSlashCommand(input: string): Promise<boolean> {
  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  const _arg = rest.join(" "); // reserved for future commands

  switch (cmd) {
    case "quit":
    case "q":
    case "exit":
      return true;

    case "tokens": {
      const used = compactor.tokensInContext;
      const window = compactor.contextWindow;
      if (used === null) {
        process.stdout.write(
          "[tokens] no usage data yet — send a prompt first.\n",
        );
      } else if (window === null) {
        process.stdout.write(`[tokens] ${used} in context\n`);
      } else {
        const pct = Math.round((used / window) * 100);
        process.stdout.write(
          `[tokens] ${used} / ${window} in context (${pct}%)\n`,
        );
      }
      return false;
    }

    case "compact": {
      // Force a compaction pass right now, regardless of threshold.
      // We pass the same `harness` reference the agent uses, so the
      // `modelCompactor` callback runs its summary through the same
      // model. Returns `null` when there's nothing to compact yet.
      const result = await compactor.compactNow(harness);
      if (result === null) {
        process.stdout.write("[compact] nothing to compact yet.\n");
      } else {
        process.stdout.write(
          `[compact] ${result.before} events → ${result.after}.\n`,
        );
      }
      return false;
    }

    case "help":
      process.stdout.write(
        [
          "  /tokens   show tokens currently in the context window",
          "  /compact  force a compaction pass now",
          "  /quit     exit",
          "",
        ].join("\n"),
      );
      return false;

    default:
      process.stdout.write(`[?] unknown command "/${cmd}". try /help.\n`);
      return false;
  }
}

function renderUpdate(u: SessionUpdate): void {
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      if (u.content.type === "text") process.stdout.write(u.content.text);
      break;
    case "tool_call":
      process.stdout.write(
        `\n[tool] ${u.title} ${JSON.stringify(u.rawInput ?? {})}\n`,
      );
      break;
    case "tool_call_update":
      if (u.status === "completed" || u.status === "failed") {
        process.stdout.write(`[${u.status}]\n`);
      }
      break;
    case "stop":
      process.stdout.write("\n");
      break;
  }
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
