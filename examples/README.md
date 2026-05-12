# Loom examples

Two ways to describe the same agent, plus the provider package they
both pull in.

| File | What it shows |
|---|---|
| [`agent.toml`](./agent.toml) | The **declarative** shape. Edit a file, run `loom audit examples/agent.toml` or `loom run examples/agent.toml`. |
| [`agent.ts`](./agent.ts) | The **imperative** SDK shape. Constructs `AnthropicHarness` as an instance, declares the rest as JS, drives the loop directly. Run via `npx tsx examples/agent.ts`. |
| [`loom-notes-provider/`](./loom-notes-provider/) | A working Loom provider package that contributes a **`NotesSession`** — a notes-taking layer for persistent recall in ~280 lines. The session loads notes from a markdown file into the system prompt every turn AND owns a `remember(fact)` tool the model uses to save new ones. |

## Run either example

```sh
# Build the loom CLI + the notes provider first.
npm run build
(cd examples/loom-notes-provider && npm run build) || true   # already committed

# Declarative:
ANTHROPIC_API_KEY=... node dist/cli/main.js run examples/agent.toml

# Imperative:
ANTHROPIC_API_KEY=... npx tsx examples/agent.ts
ANTHROPIC_API_KEY=... npx tsx examples/agent.ts "please remember that I prefer dark mode"
```

`loom audit examples/agent.toml` works without an API key — useful
when you want to see what would happen at boot without actually
running the model. You'll see the `remember` tool listed under the
session layer that contributes it.

## What the notes provider contributes

A single **Session contribution** named `loom-notes-provider`.
`NotesSession.create(config, ctx)` reads `config.file` (a markdown
file; defaults to `./loom-notes.md`), parses it for note bullets,
and:

- **Contributes a system-prompt section.** Every turn, the assembled
  prompt gains a `Notes from previous sessions:` block listing every
  saved note. The LLM has cross-run recall.

- **Contributes a `remember(fact)` tool.** Via `Session.tools()` the
  session advertises the verb name; via `Session.resolveTool()` it
  owns the implementation. Calling it appends a bullet to the
  configured file and updates the in-memory mirror so the next
  turn's prompt assembly picks it up.

- **Optional FIFO compaction.** `max_notes = N` config caps the
  list; once exceeded, the oldest entries are dropped.

This is the smallest realistic motivation for `SessionFactory`: a
plain `[tools.remember]` couldn't pull the file into the prompt;
a plain `[session]` couldn't expose a verb to the model. One
session that owns both ends is the natural shape, and v5 lets a
session register as the implicit Tools provider for the names it
contributes — no separate `[tools.remember]` entry in the manifest,
no duplicate config.

Try it:

```
$ loom run examples/agent.toml
> please remember that I'm working in TypeScript
[remember] {"fact":"User is working in TypeScript"}
[completed]
Noted — I'll keep that in mind.

> /q

$ cat examples/loom-notes.md
- (2024-11-19T15:23:01.123Z) User is working in TypeScript

$ loom run examples/agent.toml
> what do you know about me?
You're working in TypeScript.
```

## Layered sessions

The example session is a three-layer composition:

```toml
[[session.layers]]
provider = "compacting"
threshold = 60

[[session.layers]]
provider = "notes"
file = "./loom-notes.md"

[[session.layers]]
provider = "in-memory"
```

Outer-to-inner. Push flows top-to-bottom (incoming events get
compacted-side metadata stripped, pass through the notes layer
unchanged, land in `in-memory` storage). Pull flows bottom-to-top
(`in-memory` replays raw events, compacting layer rewrites the older
portion as a summary if it tripped the threshold, notes layer passes
through unchanged). System-prompt sections and contributed tools
from every layer aggregate.

For chains where no layer needs config, the inline form is shorter:

```toml
[session]
layers = ["skills", "compacting", "in-memory"]
```

Omit the `[session]` block entirely and the runtime applies the
default chain `skills → compacting → in-memory` (skills no-ops when
`~/.skills` is missing). Bounded growth and skill auto-loading out
of the box.

See [`loom-notes-provider/index.ts`](./loom-notes-provider/index.ts)
for the full registration code. The committed `index.js` is the
compiled output — re-run `npm run build` inside the provider dir
after editing.
