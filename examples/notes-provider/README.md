# notes-provider — a working Loom provider package

A complete Loom provider in ~280 lines. Contributes a single
end-to-end story: **a notes-taking session for persistent recall**
across runs of the agent.

This is the canonical reference for what a Loom provider looks like.
It's consumed by both the [`../minimal-agent/`](../minimal-agent/)
and [`../sdk-agent/`](../sdk-agent/) examples — open either of their
manifests and look for the `[providers]` block pointing at
`../notes-provider`.

## Layout

```
notes-provider/
├── README.md
├── index.ts            # source
├── index.js            # committed build output (loaded at runtime)
├── package.json        # `loom.provider` field points the loader at index.js
└── tsconfig.json
```

## What it contributes

A single **Session contribution** named `notes-provider`.
`NotesSession.create(config, ctx)` reads `config.file` (a markdown
file; defaults to `<ctx.storage>/notes.md`), parses it for note
bullets, and:

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
plain `[tools.remember]` couldn't pull the file into the prompt; a
plain `[session]` couldn't expose a verb to the model. One session
that owns both ends is the natural shape, and Loom lets a session
register as the implicit Tools provider for the names it
contributes — no separate `[tools.remember]` entry in the manifest,
no duplicate config.

## Build it

The compiled `index.js` is committed, so in steady state you don't
need to rebuild before running the examples. When iterating on
`index.ts`, re-run the build:

```sh
npm run build       # one-shot:   tsc -p tsconfig.json
npm run dev         # watch:      tsc -p tsconfig.json --watch
npm run typecheck   # no emit
```

There are **no runtime dependencies** — the provider only imports
`node:fs/promises` and `node:path`, plus Loom's types (type-only).

## How the host loads it

The `package.json` carries a `loom.provider` field pointing at
`./index.js`:

```json
{
  "loom": { "provider": "./index.js" }
}
```

A manifest declares the provider via `[providers]`:

```toml
[providers]
notes = { path = "../notes-provider" }   # relative to the manifest dir
```

At boot, Loom resolves the `path`, reads the package's
`loom.provider` field, dynamic-`import()`s the resulting JS file,
and calls its exported `register(api)` function. The provider
registers a `SessionFactory` named `notes-provider`; once a
`[[session.layers]]` entry names that provider, the runtime
instantiates it via `create(config, ctx)`.

## Reading the source

[`index.ts`](./index.ts) is heavily commented and grouped into four
sections:

1. **`NoteStore`** — the on-disk markdown file with an in-memory
   mirror. Loaded once at session construction; appended on every
   `remember` call.
2. **Config + input readers** — pull `file` / `max_notes` out of
   the session config, anchoring relative paths at `ctx.manifestDir`
   (so `./notes.md` lives next to `agent.toml`, not next to
   `process.cwd()`) and falling back to `<ctx.storage>/notes.md`.
3. **`NotesSession`** — implements `push`, `pull`,
   `systemPromptSection`, `tools()` (advertises `remember`), and
   `resolveTool` (owns the implementation).
4. **`register(api)`** — the entry point Loom calls once per
   provider-package load. Just registers the `SessionFactory`.

## See also

- The root [`README.md`](../../README.md) section **"Authoring a
  provider"** for the broader provider surface (Tools vs. Session
  vs. Harness contributions, the `loom.provider` field, the
  `register(api)` shape, secrets, capabilities).
- [`../minimal-agent/agent.toml`](../minimal-agent/agent.toml) and
  [`../sdk-agent/agent.ts`](../sdk-agent/agent.ts) — the consumers
  of this provider.
