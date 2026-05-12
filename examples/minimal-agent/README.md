# Minimal agent — declarative shape

A complete, runnable Loom agent described as a TOML manifest. This is
the recommended starting point: edit a file, run `loom audit` to see
what would happen, then `loom run` to actually drive a model.

This example is a **notes-taking assistant with persistent recall
across sessions**. It depends on the sibling provider package at
[`../notes-provider/`](../notes-provider/), which contributes a
`NotesSession` that loads remembered facts into the system prompt
every turn and a `remember(fact)` tool the model calls to save new
ones.

For the same agent built imperatively in TypeScript — with a
hand-held `CompactingSession` instance driving `/compact` and
`/tokens` slash commands — see
[`../sdk-agent/agent.ts`](../sdk-agent/agent.ts).

## Layout

```
minimal-agent/
├── README.md
└── agent.toml          # the manifest; refs ../notes-provider
```

## Run it

From the repo root (`loom/`):

```sh
# Build the loom CLI + the notes provider.
npm run build
(cd examples/notes-provider && npm run build)

# Audit prints the full resolved capability tree — every provider,
# every tool, every grant — without ever calling the model. No API
# key needed.
node dist/cli/main.js audit examples/minimal-agent/agent.toml

# Run it for real.
ANTHROPIC_API_KEY=... node dist/cli/main.js run examples/minimal-agent/agent.toml
```

In the REPL, tell the agent to remember something — a preference, a
name, a project convention. Quit with `/q`, then start it again and
ask what it knows about you. The notes from the previous session
are loaded into the prompt automatically.

```
$ loom run examples/minimal-agent/agent.toml
> please remember that I'm working in TypeScript
[remember] {"fact":"User is working in TypeScript"}
[completed]
Noted — I'll keep that in mind.

> /q

$ loom run examples/minimal-agent/agent.toml
> what do you know about me?
You're working in TypeScript.
```

The notes themselves are stored under Loom's per-agent data
directory by default (`<loom-data-home>/agents/loom-demo/notes.md`).
Set `LOOM_DATA_HOME=./scratch` to relocate it for a one-off run, or
add `file = "./somewhere.md"` to the `[[session.layers]]` block for
`notes` to pin the file next to the manifest.

## What it shows

| Block | Demonstrates |
|---|---|
| `[providers]` | Declaring a **local handle** for an external provider (`./../notes-provider`). |
| `[harness]`   | Picking a built-in harness factory (`anthropic`) and tightening tokens / turn budget. |
| `[session]`   | A **layered session**, outer-to-inner: bounded growth via `compacting`, persistent cross-session notes via the `notes` provider, raw event storage via `in-memory`. |
| `[tools]`     | Mixing **built-in tools** (`bash`, `read_file`, `write_file`, `find`) with names **contributed by the session itself** (`remember` — no explicit entry needed). |
| `[capabilities]` | The transitive ceiling: paths + subprocess allow-lists per tool, plus `remember = "*"` to permit the session-owned verb. |

The middle session layer is the interesting one — it loads notes
from a markdown file into the system prompt AND owns the `remember`
verb the model uses to save new ones. See
[`../notes-provider/index.ts`](../notes-provider/index.ts) for the
full implementation (~280 lines).
