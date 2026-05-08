# loom-sample-cli

A small interactive agent — the testbed for exercising Loom end-to-end
through the public SDK.

This package is glue code. It does not own a harness, a session, or any
tool — those all live in `loom`. The CLI just wires them together.

## What it exercises

- **Inline `AgentManifest`** construction (no `agent.toml` on disk).
- The **Anthropic harness** talking to the real Messages API.
- The **CompactingSession** for long-running conversations.
- The default **builtin tool set** (`bash`, `read_file`, `write_file`,
  `find`).
- ACP-style **`SessionUpdate`** consumption: text chunks, tool calls,
  tool results, stop reasons.
- A tiny in-house **markdown renderer** for the terminal.

## Running it

```sh
cd loom
npm install                 # builds the loom workspace
npm run build

cd samples/cli
npm install                 # picks up loom via file:..
npm run build

ANTHROPIC_API_KEY=sk-ant-... node dist/main.js
```

REPL commands:

| Input | Effect |
|---|---|
| `/quit` or `/exit` | leave the REPL |
| `/events` | print the current session event count |
| `/compact` | force a compaction pass right now (bypasses threshold) |
| any other text | sent to the agent as a turn |

`Ctrl-C` once cancels the in-flight turn; twice exits.

## Flags

```
--model <id>            Claude model id (default: claude-sonnet-4-5)
--effort <level>        low | medium | high | xhigh | max
--no-tools              disable the default builtin tools
--compact-after <n>     compact when session exceeds <n> events (default: 40)
--model-compact         use the model to write compaction summaries
--plain                 disable ANSI styling
```

## Layout

```
src/
  main.ts          entrypoint — assembles harness + session, builds the
                   AgentManifest, registers slash commands, hands a
                   RunningAgent to runCli().
  cli.ts           the REPL — takes a RunningAgent, runs turns,
                   handles slash commands, renders updates. Knows
                   nothing about which harness or session powers the
                   agent.
  markdown.ts      terminal markdown renderer (~110 LOC, no deps)
```

The split between `main.ts` and `cli.ts` is the demonstration: Loom's
`RunningAgent` is the interface a client consumes; everything else
(harness selection, session lifecycle, tool wiring) is a library
concern that lives outside the UI.

### Slash commands

`cli.ts` exposes a small extension point:

```ts
await runCli({
  agent,
  commands: [
    {
      name: "compact",
      description: "force a compaction pass right now",
      handler: async () => { /* ... */ },
    },
  ],
});
```

The REPL ships `/quit`, `/exit`, `/help`, and `/events` built-in;
clients add anything else. `/compact` is the worked example — it
closes over the `harness` and `session` references that `main.ts`
holds and drives `session.compactNow(ctx)` directly. Bypassing the
per-turn loop entirely is a property of the SDK, not a special-case
run-mode.

### Keys

| Input | Effect |
|---|---|
| `Ctrl-C` | exit at idle; cancel mid-turn; force-quit on second press |
| `Esc` | cancel the in-flight turn (no effect at idle) |

## Why this exists

Two demonstrations packed into ~350 LOC of TypeScript:

1. **End-to-end exercise** of the public SDK — every primitive Loom
   ships gets touched: harness, session, tools, `runAgent`,
   `agent.updates()`, ACP-shaped `SessionUpdate` consumption,
   per-turn `RunParameters`, the new `usage_update` event.
2. **Composition** — the CLI does **not** hand `runAgent` a declarative
   `{ provider: "anthropic", … }` config. It constructs the
   `AnthropicHarness` and `CompactingSession` instances directly,
   holds references, and passes them in. The `/compact` command
   uses those held references to drive `session.compactNow(ctx)` —
   bypassing the per-turn loop entirely. Loom is a library of
   composable parts; `runAgent` is the convenience wrapper, not a
   gatekeeper.
