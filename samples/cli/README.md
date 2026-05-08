# loom-sample-cli

A minimal Loom client. ~110 LOC total — the smallest meaningful demo
of embedding Loom into your own application.

## What it shows

- **Construct primitives directly** (`AnthropicHarness`,
  `CompactingSession`, `MemorySession`) and pass them to `runAgent` as
  instances rather than declaring them in a manifest. Loom is a library
  of composable parts; the manifest is one entry point, not a gate.
- **Subscribe to `agent.updates()`** and render events in your own way.
  Here we just print agent text inline; real clients can do anything
  the `SessionUpdate` type allows.
- **Drive turns via `agent.prompt(text)`** in a tiny readline loop.

## What it doesn't do

- No slash commands, no streaming markdown, no tool-call pairing, no
  history replay. For the polished interactive experience use
  `loom run <agent.toml>` from the loom package.
- No agent.toml. Everything is built in code so you can see exactly
  which primitives are involved.
- No file persistence. The session is in-memory; conversations don't
  survive a restart. Add `FileSession` if you want them to.

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

## When to look at this

You're embedding Loom into your own application — a Discord bot, an
HTTP service, a custom IDE plugin — and want to see the smallest
possible glue between Loom and your driver code. ~80 lines of `main.ts`,
no dependencies beyond `loom` and `node:readline`.

For interactive use, see `loom run <agent.toml>` in the loom CLI:

```sh
loom run path/to/agent.toml
```

That gives you the full REPL experience (slash commands, streaming
markdown, paired tool-call rendering, audit on demand, history replay).
