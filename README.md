# Loom

> A capability-secure, manifest-driven agent runtime.

Loom turns an `agent.toml` (or a `runAgent(...)` call) into a running
agent. You describe what the agent is — which model, which session,
which tools, what it's allowed to do — and Loom assembles the harness
from built-in primitives and third-party packages. Loom ensures that your
agent never sees a secret it shouldn't, and uses a "What you see is what you get"
approach to security based on _tool capabilities_. 

```toml
[agent]
name = "demo"
system_prompt = "You are a helpful assistant." # Customize for your needs

[harness]
provider = "anthropic" # Harness will inform Loom it needs an ANTHROPIC_API_KEY
model    = "claude-sonnet-4-5"

[tools] # Default tools come built in
bash       = "builtin"
read_file  = "builtin"
write_file = "builtin"
find       = "builtin"

[capabilities] # Flexible security model, that fits what you need.
# Read files in this directory and another
read_file  = { paths = ["./", "../other-files",] } 
find       = { paths = ["./", "../other-files"] } 
# But writing is restricted to the current directory
bash       = { subprocess = "*", paths = ["./"] } # Sandboxed by default
write_file = { paths = ["./"] }
```

```sh
ANTHROPIC_API_KEY=... loom run agent.toml
```

> **Status: early.** The shapes (manifest, capability model, session
> layers, ACP wire protocol) are solid; specific API surfaces are
> still moving. Pin to a commit if you're integrating.

---

## Why Loom

Loom is a package manager for agents, that lets you quickly spin up new agents from re-usable parts. It's intended for systems that need lots of micro-agents working together, with little oversight but a clear security posture. Want to build a swarm of agents to expand your claw's reach? Need to run an agent in CI, that talks to the network, and never have to worry about prompt injection? Do you just want to build a memory system and not have to worry about *everything* that goes into building an Agent harness? Then Loom is for you. 

Loom is based on Anthropic's [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents), with some adjustments to provide rich APIs:

- A *harness*, is responsible for acquiring tokens and dispatching according to each model's APIs. Loom ships with an Anthropic and OpenAI harness out of the box, but you can easily write your own for any other model provider. Have a local deepseek install? 

- **Composition is declarative.** The agent's identity, model,
  session backend, tools, capability ceiling, and sub-agents are
  fields in one file. The runtime is what reads the file.
- **Capabilities are first-class.** `[capabilities]` is the single
  source of truth for what each tool may do. Tools self-police on the
  grant; sub-agents can't exceed their parent's grant; `loom audit`
  walks the whole tree without running the model.
- **Providers are npm packages.** A "provider" is just an npm package
  with a `loom.provider` field in its `package.json`. It contributes
  harnesses, sessions, and Tools instances through a uniform
  `register(api)` entry point. Same shape for built-ins and
  third-parties — built-ins just happen to be bundled.
- **ACP is the wire protocol.** When run as `loom acp serve`, Loom
  speaks [Agent Client Protocol][acp] over stdio. Drop-in usable from
  any ACP-aware client (editors, IDEs, scripts).

[acp]: https://github.com/agentclientprotocol/spec

---

## Install

```sh
git clone https://github.com/<you>/loom.git
cd loom
npm install
npm run build
node dist/cli/main.js help
```

Once published:

```sh
npm install -g loom
loom help
```

Requires Node 20 or newer.

---

## Quick start

### 1. Write an `agent.toml`

```toml
[agent]
name = "scribe"
system_prompt = "You are a helpful assistant who edits files carefully."

[harness]
provider  = "anthropic"
model     = "claude-sonnet-4-5"
maxTokens = 4096

# No [session] block — the default chain applies
# (`skills → compacting → in-memory`). Bounded growth, skill
# auto-loading from `~/.skills`, volatile storage for the process.
# Want persistence across runs? See the layered example below.

[tools]
read_file  = "builtin"
write_file = "builtin"
find       = "builtin"

[capabilities]
read_file  = { paths = ["./"] }
write_file = { paths = ["./"] }
find       = { paths = ["./"] }
```

If you want the conversation to persist across runs, declare a
session explicitly:

```toml
[[session.layers]]
provider  = "compacting"
threshold = 60

[[session.layers]]
provider = "file"
path     = "./scribe.jsonl"   # raw events on disk; survives restart
```

### 2. Audit it first

```sh
loom audit agent.toml
```

You'll see exactly which providers load, which tools resolve, what
they're granted, and what secrets they want. No model gets called.

### 3. Run it

```sh
ANTHROPIC_API_KEY=... loom run agent.toml
```

Or one-shot:

```sh
ANTHROPIC_API_KEY=... loom prompt agent.toml "rename foo.txt to bar.txt"
```

Or serve it to an ACP-aware client:

```sh
loom acp serve agent.toml         # speaks ACP on stdio
```

---

## The model in 30 seconds

A Loom agent is composed from four kinds of things:

| Kind | What it is |
|---|---|
| **Provider** | An npm package (or local path) that contributes code. The package.json's `loom.provider` field points at an entry that `register()`s harnesses, sessions, and Tools instances. |
| **Harness** | The model API loop. Anthropic, OpenAI, and a scripted `test` harness ship in-box. |
| **Session** | The conversational state layer, declared as a singleton or a stack of **layers**. Built-ins: `in-memory` (volatile), `file` (JSONL on disk), `compacting` (pull-side summariser), `skills` (Anthropic-style skill loader), `fork-of-parent` (sub-agent fork). The default when the manifest is silent is the chain `skills → compacting → in-memory` (skills no-ops if `~/.skills` is missing). |
| **Tool** | A JS object the model calls. `bash`, `read_file`, `write_file`, `find`, `spawn_subagent` ship in-box. Each tool reads its capability grant on every call. |

Wherever the manifest references code — `[harness]`, `[session]` (or
entries of `[session].layers`), each `[tools.X]` — the field is
**`provider`**. Its value is one of:

- a built-in name: `"anthropic"`, `"file"`, `"builtin"`
- a `[providers]` handle (declared locally for reuse / version-pinning)
- an inline source: `"@my-org/loom-fetch"`, `"./local-provider"`, or
  the table forms `{ npm = "..." }` / `{ path = "..." }`

The `[providers]` table is optional — declare a handle there when you
reference the same package more than once, or want to version-pin it.

```toml
[providers]
mcp = { npm = "@my-org/loom-mcp", version = "^1.2" }

[tools]
list_files       = { provider = "mcp", server = "filesystem" }
read_file_remote = { provider = "mcp", server = "filesystem" }  # shares instance
list_repos       = { provider = "mcp", server = "github" }       # different config → different instance
```

The runtime dedupes Tools instances by `(resolved source, config)`,
so two tools with the same provider and same config share one
instance — implicit pooling, no extra wiring.

---

## Two patterns: TOML and SDK

The same agent, two ways to describe it.

### TOML (declarative)

See `examples/agent.toml`. Edit a file, run `loom audit` or `loom run`.

### SDK (imperative)

See `examples/agent.ts`. Construct primitives directly, hold
references, drive your own loop:

```ts
import {
  AnthropicHarness,
  runAgent,
  type AgentManifest,
} from "loom";

const harness = new AnthropicHarness(
  "claude-sonnet-4-5",
  process.env.ANTHROPIC_API_KEY!,
  "https://api.anthropic.com",
  4096, 16, true,
);

const manifest: AgentManifest = {
  name: "demo",
  systemPrompt: "You are a helpful assistant.",
  harness,                                            // instance, not spec
  // Layered session (outer-to-inner). Pass a `SessionSpec[]` for the
  // declarative form, or a pre-built `Session` instance if you want
  // to hold direct references to the layers.
  session: [
    { provider: "compacting", threshold: 60 },
    { provider: "file", path: "./demo.jsonl" },
  ],
  tools: { bash: "builtin", read_file: "builtin" },
  capabilities: {
    bash: { subprocess: "*", paths: ["./"] },
    read_file: { paths: ["./"] },
  },
};

const agent = await runAgent(manifest);

// Stream updates in the background while you drive the prompt.
void (async () => {
  for await (const update of agent.updates()) {
    // render however you want — see examples/agent.ts for a tiny renderer
  }
})();

await agent.prompt("hi");
await agent.close();
```

`AgentManifest` accepts both spec form (`{ provider: "anthropic", model: ... }`)
and instance form (`new AnthropicHarness(...)`) for `harness`, and
three forms for `session`: a single `SessionSpec`, a `SessionSpec[]`
(layered), or a pre-built `Session` instance. Pick whichever fits.

### Layered sessions

A session in Loom is either a single layer or a stack of layers.
The `Session` interface defines the composition protocol:

- `push` flows **top-to-bottom**. Each layer may transform, drop, or
  fan-out the event before the next layer sees it. The bottom layer
  is typically storage.
- `pull` flows **bottom-to-top**. Each layer receives what the layers
  below it produced and may rewrite it. The top is what the harness
  sees as the prompt.
- Every other hook (`tools()`, `systemPromptSection()`,
  `trustedPaths()`, `prepareTurn()`, `close()`) aggregates across
  layers.

Declare layers with `[[session.layers]]` (TOML array-of-tables) or
`[session] layers = [...]` (inline form, all-strings or all-tables
thanks to a TOML parser quirk). From the SDK, pass a `SessionSpec[]`
on `AgentManifest.session`. A singleton `[session]` with just
`provider = "..."` is the trivial one-layer case. The
default-when-absent is the chain `skills → compacting → in-memory`,
producing bounded growth and skill auto-loading out of the box.

---

## Capabilities

Every tool declares the capability *kinds* it needs (`requires`) and
those it may use if granted (`optional`). The manifest's
`[capabilities]` table grants them, per-tool:

```toml
[capabilities]
bash       = { subprocess = "*", paths = ["./"], env = ["PATH", "HOME"] }
read_file  = { paths = ["./"] }
write_file = "*"                # whole-tool unrestricted
fetch_url  = "*"
```

A grant value is one of:

- **`"*"`** — whole-tool unrestricted (sandbox engagement opts out).
- **`{ kind = value }`** — per-kind, where `value` is `"*"`, an
  allowlist array (`["./src", "./test"]`), or a kind-defined object.
- **`{}`** — nothing granted. Tools with non-empty `requires` fail boot.

Kinds shipped by the built-in tools:

| Kind         | Used by | Semantics |
|---|---|---|
| `paths`      | `read_file`, `write_file`, `find`, `bash` | `"*"` any FS; `["./"]` allowlist; absent → smart default |
| `subprocess` | `bash` | `"*"` allow exec; absent → deny |
| `network`    | `bash` | `"*"` allow; absent → deny |
| `env`        | `bash` | Two-tier inheritance — see below. |

**Bash env inheritance** is tiered:

- **Tier 1 — always inherited.** `HOME`, `USER`, `LOGNAME`, `SHELL`,
  `TERM`, `COLORTERM`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`. Locale
  and terminal plumbing; never overridable. A hermetic shell with
  broken locale and no `$HOME` isn't hermetic, it's broken.
- **Tier 2 — default-on, replaceable.** `PATH`, `PWD`, `TMPDIR`,
  `EDITOR`, `VISUAL`, `PAGER`. Included when `env` is absent;
  dropped when `env` is an explicit list.

Grant table:

| Grant | Result |
|---|---|
| `env` absent | Tier 1 + Tier 2 (the convenient default) |
| `env = "*"` | full `process.env` |
| `env = []` | Tier 1 only (hermetic-but-functional) |
| `env = ["NAME"]` | Tier 1 + `NAME` |
| `env = ["AWS_*"]` | Tier 1 + prefix match on `AWS_` |

`[capabilities]` is also a **transitive ceiling** across the
sub-agent tree: every sub-agent's effective grants must be a subset
of its parent's. `loom audit` walks the whole tree statically and
reports violations before they hit at runtime.

---

## Authoring a provider

A Loom provider is an npm package whose `package.json` has a
`loom.provider` field:

```json
{
  "name": "@my-org/loom-fetch",
  "type": "module",
  "loom": { "provider": "./dist/index.js" }
}
```

The entry exports `register(api)`. The three contribution methods
(`registerTools`, `registerHarness`, `registerSession`) all take the
same `ContributionRegistration<T>` shape — `register<X>` returns an
`X`:

```ts
import type { LoomProviderApi } from "loom";

export function register(api: LoomProviderApi): void {
  api.registerTools({
    name: "@my-org/loom-fetch",
    secrets: { required: ["FETCH_KEY"] },
    async create(config, ctx, secrets) {
      const client = makeClient(secrets["FETCH_KEY"]);
      return {
        resolveTool(name, _config, _agent, capabilities) {
          if (name !== "fetch_url") return null;
          return {
            name: "fetch_url",
            description: "GET a URL and return the body.",
            inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
            requires: ["network"],
            capabilities,
            async execute(input) { /* … */ },
          };
        },
      };
    },
  });
}
```

Then in the manifest:

```toml
[tools]
fetch_url = { provider = "@my-org/loom-fetch", url_prefix = "https://api.example.com/" }

[capabilities]
fetch_url = { network = "*" }
```

Discovery walks `<manifest-dir>/node_modules` → `npm root -g` →
`~/.loom/providers`. `loom providers list` enumerates everything
visible.

Sessions can also own a tool's implementation directly. A `Session`
that advertises a tool name via `tools()` AND implements
`resolveTool(name, config, agent, capabilities)` is treated as the
implicit Tools provider for that name — no separate `[tools.X]`
entry needed in the manifest. This is the pattern
`examples/loom-notes-provider/` uses to bundle a `remember` verb
with a `NotesSession` that loads and replays remembered facts.

See `examples/` for working providers.

---

## Examples

Everything in `examples/` is real, runnable, and audited under
`loom audit examples/agent.toml`.

| File / directory | What it demonstrates |
|---|---|
| [`examples/agent.toml`](./examples/agent.toml) | **The declarative shape.** An agent with a 3-layer session (`compacting` → `notes` → `in-memory`), built-in tools, capability grants, and a local provider reference. Run with `loom run examples/agent.toml`. |
| [`examples/agent.ts`](./examples/agent.ts) | **The imperative SDK shape.** Same agent, constructed in TypeScript. Shows the `AnthropicHarness` instance form, the `SessionSpec[]` array form, and a tiny update renderer. Run with `npx tsx examples/agent.ts`. |
| [`examples/loom-notes-provider/`](./examples/loom-notes-provider/) | **A complete working provider package.** Contributes a single `NotesSession` that loads remembered facts from a markdown file into the system prompt every turn AND owns a `remember(fact)` tool the model uses to save new ones. ~280 lines. Demonstrates the session-as-Tools-provider pattern. |
| [`examples/loom-notes-provider/index.ts`](./examples/loom-notes-provider/index.ts) | The provider source. Shows `register(api)`, `api.registerSession(...)`, the `Session.resolveTool` method, and how a session owns both ends of a verb (advertise + implement). |

The quickest way to see Loom end-to-end:

```sh
npm run build
(cd examples/loom-notes-provider && npm run build)
ANTHROPIC_API_KEY=... node dist/cli/main.js run examples/agent.toml
```

Then ask the agent to remember something:

```
> Please remember that I prefer dark mode.
[remember] {"fact":"User prefers dark mode"}
Noted — I'll keep that in mind.
```

Restart the agent; the note is replayed into the system prompt and
the model recalls it.

---

## CLI reference

| Command | What it does |
|---|---|
| `loom run <agent.toml>` | Interactive REPL with streaming markdown, slash commands (`/help`, `/audit`, `/tools`, `/events`), and history replay. |
| `loom prompt <agent.toml> [text]` | One-shot prompt (`text` or stdin). Exits after the turn completes. |
| `loom audit <agent.toml> [--json] [--strict]` | Static capability tree. No model calls. `--strict` fails when any source can't be loaded. |
| `loom acp serve <agent.toml>` | Speak [ACP][acp] over stdio. Pairs with any ACP-aware client. |
| `loom install [agent.toml]` | Materialise the manifest's npm/path sources into `.loom/node_modules/`. `--frozen` for CI. |
| `loom providers list` | List Loom provider packages discoverable from cwd. |
| `loom providers info <name>` | Show resolved metadata for a provider package. |

---

## What's in the box

**Harnesses:** `anthropic`, `openai`, `test`, `small-model-of-parent`

**Sessions:** `in-memory`, `file`, `compacting`, `skills`,
`fork-of-parent`

**Tools:** `bash` (with macOS sandbox-exec / Linux bwrap profile
derivation), `read_file`, `write_file`, `find`, `spawn_subagent`

**Secret stores** (chained, in order): a caller-supplied store, env
vars, XDG-spec `$XDG_CONFIG_HOME/loom/secrets`, the OS keychain (when
available), and a `.loom-secrets` file next to the manifest.

---

## Architecture

For contributors and the curious, the source tree reads top-down:

1. **`src/types/`** — manifest types, runtime interfaces, ACP types.
2. **`src/manifest/`** — parser → resolver → capabilities. Pure: no
   I/O beyond reading the file.
3. **`src/runtime/`** — system-prompt assembly, tool table, update
   sink, sandbox profiles, shared boot helpers (`runtime/boot.ts`).
4. **`src/builtins/`** — the harness, session, and tool implementations
   that ship in-box.
5. **`src/providers/loader.ts`** — npm/path discovery and the
   `LoomProviderApi` glue.
6. **`src/sdk/run-agent.ts`** — `runAgent()` ties everything together.
7. **`src/cli/`**, **`src/acp/`**, **`src/audit/`** — surfaces on top.

The canonical manifest design lives in
[`internal-docs/manifest-v5.md`](./internal-docs/manifest-v5.md).

---

## Development

```sh
npm install
npm run build          # tsc → dist/
npm test               # vitest run, 300+ tests
npm run lint           # typecheck tests too
npm run dev            # tsc --watch
```

Run the example agent against the notes provider:

```sh
ANTHROPIC_API_KEY=... node dist/cli/main.js run examples/agent.toml
# or via the SDK:
ANTHROPIC_API_KEY=... npx tsx examples/agent.ts "your prompt here"
```

---

## License

MIT.
