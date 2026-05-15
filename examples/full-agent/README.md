# Full agent — declarative shape

A complete, runnable Loom agent described as a TOML manifest. This is
the recommended starting point: edit a file, run `loom audit` to see
what would happen, then `loom run` to actually drive a model — or
wire it into Zed (or any other ACP-speaking editor) for an in-IDE
experience.

This example is a **notes-taking assistant with persistent recall
across sessions**, plus **web search and fetch** via Anthropic's
server-side tools. It depends on the sibling provider package at
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
full-agent/
├── README.md
└── agent.toml          # the manifest; refs ../notes-provider
```

## Run it in a terminal

From the repo root (`loom/`):

```sh
# Build the loom CLI + the notes provider.
npm run build
(cd examples/notes-provider && npm run build)

# Audit prints the full resolved capability tree — every provider,
# every tool, every grant — without ever calling the model. No API
# key needed.
node dist/cli/main.js audit examples/full-agent/agent.toml

# Run it for real.
ANTHROPIC_API_KEY=... node dist/cli/main.js run examples/full-agent/agent.toml
```

In the REPL, tell the agent to remember something — a preference, a
name, a project convention. Quit with `/q`, then start it again and
ask what it knows about you. The notes from the previous session
are loaded into the prompt automatically.

```
$ loom run examples/full-agent/agent.toml
> please remember that I'm working in TypeScript
[remember] {"fact":"User is working in TypeScript"}
[completed]
Noted — I'll keep that in mind.

> /q

$ loom run examples/full-agent/agent.toml
> what do you know about me?
You're working in TypeScript.
```

## Run it in Zed (over ACP)

Loom ships with a built-in [Agent Client Protocol](https://agentclientprotocol.com)
server (`loom acp serve`). Zed has native ACP support, so this
agent can run inside Zed's agent panel just like the built-in
agents — with streaming responses, in-IDE tool-call rendering,
permission prompts, and the rest.

Add to `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "Loom (full-agent demo)": {
      "type": "custom",
      "command": "node",
      "args": [
        "/absolute/path/to/loom/dist/cli/main.js",
        "acp",
        "serve",
        "/absolute/path/to/loom/examples/full-agent/agent.toml"
      ],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Replace both `/absolute/path/to/loom/` with the absolute path on
your machine (Zed's `settings.json` doesn't expand `~`), and put a
real API key in `env`.

Then `cmd-?` to open the agent panel, click `+` ("New Thread"),
and select "Loom (full-agent demo)" from the list. Stream-back
streams; `remember` calls render as tool-call cards; errors land
as proper error toasts. The `dev: open acp logs` command palette
entry shows every JSON-RPC frame in both directions for debugging.

The notes file lives at the resolved storage path (`loom audit`
prints it at the top — typically
`~/Library/Application Support/Loom/agents/loom-demo/notes.md` on
macOS). It persists across both `loom run` and Zed sessions.

When you try `web_search` or `web_fetch` in Zed, the tool-call cards
render the structured results inline; the encrypted-content blobs
are carried on the session's `rawOutput` so they survive subsequent
turns within the same conversation and the model can re-cite
sources without re-searching.

The notes themselves are stored under Loom's per-agent data
directory by default. Set `LOOM_DATA_HOME=./scratch` to relocate
it for a one-off run, or add `file = "./somewhere.md"` to the
`[[session.layers]]` block for `notes` to pin the file next to
the manifest.

## What it shows

| Block | Demonstrates |
|---|---|
| `[providers]` | Declaring a **local handle** for an external provider (`./../notes-provider`). |
| `[harness]`   | Picking a built-in harness factory (`anthropic`) and tightening tokens / turn budget. |
| `[session]`   | A **layered session**, outer-to-inner: bounded growth via `compacting`, persistent cross-session notes via the `notes` provider, raw event storage via `in-memory`. |
| `[tools]`     | Three flavours side-by-side: **built-in tools** (`bash`, `read_file`, `write_file`, `edit_file`, `find`), names **contributed by the session itself** (`remember` — no explicit entry needed), and **harness-exposed server tools** (`web_search`, `web_fetch` via `provider = "anthropic"`). |
| `[capabilities]` | The transitive ceiling: paths + commands allow-lists per tool, plus `remember = "*"` to permit the session-owned verb. Server tools need no local capability grant — they have no local execution surface. |

The middle session layer is the interesting one — it loads notes
from a markdown file into the system prompt AND owns the `remember`
verb the model uses to save new ones. See
[`../notes-provider/index.ts`](../notes-provider/index.ts) for the
full implementation (~280 lines).

### Anthropic server tools

`web_search` and `web_fetch` are dispatched **API-side by Anthropic**,
not by the local runtime. The model's tool call and the result land in
the same assistant message; there's no local network egress and no
extra API key needed beyond `ANTHROPIC_API_KEY`. Usage is billed on
your Anthropic account — each call counts as a `web_search_requests`
or `web_fetch_requests` line on the response's usage payload. The
`max_uses` cap in the manifest is a hard upper bound per turn.

A quick interaction:

```
> what's new in claude 4.5?
[web_search] {"query":"claude 4.5 release notes"}
[completed]
Anthropic released Claude Sonnet 4.5 in September 2025 with … [cites docs.anthropic.com]

> can you read the full announcement?
[web_fetch] {"url":"https://www.anthropic.com/news/claude-sonnet-4-5"}
[completed]
The announcement covers four main areas: …
```

The rendered tool-call cards in Zed show the search results and
fetched page contents under each call, with citations linkable in
the model's reply.

**Two `web_search` flavours.** Loom ships two implementations of the
same model-facing verb:

| Flavour | Provider | Bill | Works with |
|---|---|---|---|
| `web_search = "builtin"` | Brave LLM Context API | Brave (BRAVE_SEARCH_API_KEY) | Any harness |
| `[tools.web_search] provider = "anthropic"` | Anthropic server tool | Anthropic API | Anthropic harness only |

They're mutually exclusive per manifest — pick one. The Brave path is
the portable option (use it when you might swap harnesses or want
separate billing); the Anthropic path is the lowest-friction option
when you're already on Claude (one less API key to manage, no
separate quota to monitor, and the model gets `encrypted_content`
back for citation re-grounding on subsequent turns).
