# Loom examples

Five self-contained example projects. Each has its own `README.md`
with build, run, and pedagogy notes — start there.

| Project | What it shows |
|---|---|
| [`minimal-agent/`](./minimal-agent/) | **Start here.** The smallest useful agent as a single TOML manifest — built-in file/shell tools scoped to the cwd, a two-layer session, capability grants. No provider, no build step. The **declarative shape** at its simplest. |
| [`full-agent/`](./full-agent/) | The same declarative shape, fully loaded: a notes-taking assistant with persistent recall (a `notes` provider layer) plus harness-exposed web search. |
| [`sdk-agent/`](./sdk-agent/) | The same notes-taking agent as `full-agent/`, but built **imperatively** with the SDK. Shows the heterogeneous session-array shape: `session: [compactor, "notes", "in-memory"]` mixes a hand-built `CompactingSession` with named layers the runtime resolves. The instance is what `/compact` and `/tokens` slash commands reach into. |
| [`mcp-agent/`](./mcp-agent/) | An agent wired up to a stand-alone [Model Context Protocol](https://modelcontextprotocol.io) server (also included). The canonical tour of Loom's built-in `mcp-server` meta-provider — rename, narrow, pre-bind, and secret-inject MCP tools through the manifest. |
| [`notes-provider/`](./notes-provider/) | A working Loom provider package in ~280 lines. Contributes a `NotesSession` for persistent recall across runs. **Consumed by both `full-agent/` and `sdk-agent/`**; read on its own as the canonical reference for what a provider looks like. |

## Dependencies between examples

```
minimal-agent/   (standalone — no provider)

full-agent/  ─┐
              ├─→  notes-provider/
sdk-agent/   ─┘

mcp-agent/  ──→  mcp-agent/mcp-server/   (the MCP server lives inside the project)
```

The `notes-provider/` package is shared by the two notes-taking
agent examples. `minimal-agent/` depends on nothing. The MCP server
is self-contained inside `mcp-agent/`. There is no cross-project
coupling beyond what's shown above.

## Quick start

The shortest possible path from a fresh clone to a running agent —
`minimal-agent/` needs no provider build:

```sh
# From the repo root.
npm run build
ANTHROPIC_API_KEY=... node dist/cli/main.js run examples/minimal-agent/agent.toml
```

`loom audit examples/minimal-agent/agent.toml` works without an API
key — useful when you want to see what would happen at boot without
actually running the model. For the notes-taking agents, build the
provider first: `(cd examples/notes-provider && npm run build)`.
