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
| any other text | sent to the agent as a turn |

`Ctrl-C` once cancels the in-flight turn; twice exits.

## Flags

```
--model <id>            Claude model id (default: claude-3-5-sonnet-latest)
--no-tools              disable the default builtin tools
--compact-after <n>     compact when session exceeds <n> events (default: 40)
--plain                 disable ANSI styling
```

## Layout

```
src/
  main.ts          REPL + update-stream printer
  markdown.ts      terminal markdown renderer (~110 LOC, no deps)
```

## Why this exists

To find the rough edges before they ossify. The first pass surfaced
notes recorded in `../../internal-docs/session-notes.md` — chiefly
that `Session` does not currently see the harness or system prompt,
which makes model-driven compaction awkward. The heuristic compactor
sidesteps this; a model-driven one would need a small `Session`
interface change.
