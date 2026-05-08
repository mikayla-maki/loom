#!/usr/bin/env node
/**
 * loom-sample-cli — a minimal Loom client.
 *
 * Demonstrates that embedding Loom is cheap: ~50 lines, no fancy UI,
 * no agent.toml. Constructs primitives in code and hands them to
 * `runAgent` as instances.
 *
 * For the polished interactive experience (slash commands, history
 * replay, streaming markdown, paired tool-call rendering), use
 * `loom run <agent.toml>` from the loom package itself.
 *
 * Usage: ANTHROPIC_API_KEY=... loom-sample-cli
 */

import * as readline from "node:readline";
import { stdin, stdout, stderr, exit } from "node:process";

import {
  runAgent,
  AnthropicHarness,
  CompactingSession,
  MemorySession,
  type AgentManifest,
  type SessionUpdate,
} from "loom";

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    stderr.write("error: set ANTHROPIC_API_KEY before running.\n");
    exit(2);
  }

  // Build primitives directly, not via manifest config. This is the
  // "Loom is a library" demo: AnthropicHarness and CompactingSession
  // are concrete classes you can construct, hold references to, and
  // pass into runAgent as instances.
  const harness = new AnthropicHarness(
    "claude-sonnet-4-5",
    apiKey!,
    "https://api.anthropic.com",
    4096,
    16,
    true, // streaming
  );
  const session = new CompactingSession(new MemorySession(), {
    threshold: 40,
    keep: 10,
  });

  const manifest: AgentManifest = {
    name: "minimal-sample",
    systemPrompt: "You are a helpful assistant.",
    harness, // ← instance, not config
    session, // ← instance
  };

  const agent = await runAgent(manifest);

  // Subscribe to updates and print agent text inline. Tool calls
  // get a one-line summary; everything else is dropped. Real clients
  // do nicer rendering (see `loom run`).
  void (async () => {
    for await (const u of agent.updates()) renderUpdate(u);
  })();

  const rl = readline.createInterface({ input: stdin, output: stdout });
  stdout.write("loom-sample-cli ready. Type a prompt; Ctrl-D to quit.\n");

  const ask = (): Promise<string | null> =>
    new Promise((resolve) => {
      rl.question("> ", (line) => resolve(line));
      rl.once("close", () => resolve(null));
    });

  try {
    while (true) {
      const line = await ask();
      if (line === null) break;
      if (!line.trim()) continue;
      try {
        await agent.prompt(line);
      } catch (e) {
        stderr.write(`error: ${(e as Error).message}\n`);
      }
    }
  } finally {
    rl.close();
    await agent.close();
  }
}

/** Tiny inline renderer — print agent text and tool one-liners. */
function renderUpdate(u: SessionUpdate): void {
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      if (u.content.type === "text") stdout.write(u.content.text);
      break;
    case "tool_call":
      stdout.write(`\n[tool] ${u.title} ${JSON.stringify(u.input)}\n`);
      break;
    case "tool_call_update":
      if (u.status === "completed" || u.status === "failed") {
        stdout.write(`[${u.status}]\n`);
      }
      break;
    case "stop":
      stdout.write("\n");
      break;
  }
}

main().catch((e) => {
  stderr.write(`${(e as Error).stack ?? e}\n`);
  exit(1);
});
