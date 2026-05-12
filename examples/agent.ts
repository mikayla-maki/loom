#!/usr/bin/env node
/**
 * Loom SDK example — the same agent as `examples/agent.toml`, but
 * constructed in TypeScript. This is the "Loom is a library" pattern:
 * you build the primitives in code, hold direct references to them,
 * and hand a `RunningAgent` to your own driver loop.
 *
 * The TOML version (`examples/agent.toml`) is the declarative shape;
 * this file is the imperative shape. They produce the same agent.
 *
 * What changes between the two:
 *   - `[harness]` becomes `new AnthropicHarness(...)` — an instance you
 *     hold a reference to. You could swap a config-driven harness
 *     (`{ provider: "anthropic", model: "..." }`) here too; the SDK
 *     accepts either form.
 *   - `[providers]`, `[session]`, `[tools]`, `[capabilities]` are
 *     the same shape as the TOML, just expressed as JS objects. A
 *     layered session is a `SessionSpec[]` on `manifest.session`;
 *     a singleton session is a `SessionSpec` (just `{ provider: ... }`).
 *   - You can also pass a pre-built `Session` instance — e.g. a
 *     hand-constructed `ChainedSession` — if you want a reference to
 *     the underlying layers (handy for wiring `/compact` to a
 *     specific `CompactingSession.compactNow()`).
 *
 * Run:
 *
 *   ANTHROPIC_API_KEY=... npx tsx examples/agent.ts
 *   ANTHROPIC_API_KEY=... npx tsx examples/agent.ts "one-shot prompt"
 */

import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  AnthropicHarness,
  runAgent,
  type AgentManifest,
  type SessionSpec,
  type SessionUpdate,
} from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  process.stderr.write("error: set ANTHROPIC_API_KEY before running.\n");
  process.exit(2);
}

// ─── Build the harness as an instance ──────────────────────────────────────
//
// Equivalent to the `[harness]` block in agent.toml, but constructed
// directly. Holding the reference lets you do things the manifest form
// can't — e.g. swap models per-turn via `harness.withModel(...)`,
// re-use the same harness across multiple agents, or drive
// `summarise()` directly for compaction.

const harness = new AnthropicHarness(
  "claude-sonnet-4-5", // model
  apiKey,
  "https://api.anthropic.com", // apiBase
  4096, // maxTokens
  16, // maxTurnRequests
  true, // stream
);

// ─── Compose the manifest ─────────────────────────────────────────────────
//
// `manifestPath` anchors relative SourceSpecs (the `./loom-notes-provider`
// path below) to this file's directory. Without it, paths resolve
// against `process.cwd()`.

const manifest: AgentManifest = {
  manifestPath: path.join(__dirname, "agent.ts"),
  name: "loom-demo",
  systemPrompt:
    "You are a helpful assistant who keeps notes across sessions. The " +
    "system prompt includes notes from previous sessions. When the user " +
    "tells you something worth keeping — preferences, project " +
    "conventions, names, recurring context — call the `remember` tool " +
    "with a short declarative fact. Use bash/read_file/write_file/find " +
    "for real work.",

  providers: {
    notes: { path: "./loom-notes-provider" },
  },

  harness, // ← instance, not spec

  // Layered session (outer-to-inner). Same shape as `[session].layers`
  // / `[[session.layers]]` in agent.toml. The `notes` layer is a
  // `NotesSession` that loads notes from disk and owns the `remember`
  // tool.
  session: [
    { provider: "compacting", threshold: 60 },
    { provider: "notes", file: "./loom-notes.md" },
    { provider: "in-memory" },
  ] satisfies SessionSpec[],

  // `remember` isn't listed here — the `demo` session contributes it
  // and owns the implementation. The runtime auto-registers it.
  tools: {
    bash: "builtin",
    read_file: "builtin",
    write_file: "builtin",
    find: "builtin",
  },

  capabilities: {
    bash: { subprocess: "*", paths: ["./"] },
    read_file: { paths: ["./"] },
    write_file: { paths: ["./"] },
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

  try {
    while (true) {
      let line: string;
      try {
        line = await rl.question("> ");
      } catch {
        // readline rejects on close (Ctrl-D).
        break;
      }
      if (!line.trim()) continue;
      try {
        await agent.prompt(line);
      } catch (e) {
        process.stderr.write(`error: ${(e as Error).message}\n`);
      }
    }
  } finally {
    rl.close();
    await agent.close();
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
