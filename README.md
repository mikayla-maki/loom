# Loom

> A capability-secure, manifest-driven agent runtime.

>[!NOTE]
> Humans, start here:

Loom is a package manager and runtime for agent harnesses. Define
your agent's features and capabilities in a `agent.toml` manifest,
check what it can do via  `loom audit`, then prompt it anywhere, anytime 
via `loom prompt`:

```toml
[agent]
name = "example-agent"
system_prompt = "You are a helpful assistant." # Customize for your needs

[harness]
provider = "anthropic" # This harness will inform Loom it needs an ANTHROPIC_API_KEY
model    = "claude-sonnet-4-5"

# Define what context management features you need
[session]
layers = ["skills", "compacting", "in-memory"]

 # Default tools come built in
[tools]
bash       = "builtin"
read_file  = "builtin"
write_file = "builtin"
find       = "builtin"

# Use capabilities to define a flexible security model that fits your needs
[capabilities] 
# Read files in this directory and another
read_file  = { paths = ["./", "../other-files",] } 
find       = { paths = ["./", "../other-files"] } 
# Writing files is restricted to the current directory
bash       = { subprocess = "*", paths = ["./"] } # Sandboxed by default, no network access
write_file = { paths = ["./"] }
```

```sh
ANTHROPIC_API_KEY=... loom run agent.toml
```

> **Status: early.** I've burned a lot of tokens on this project, and the provider
> APIs are likely to be stable. However, as I discover new use cases, the APIs will
> likely expand. This project has been entirely vibe coded, so don't trust it with your production data just yet :)

---

## Why Loom

Loom is a package manager for agents, that lets you spin up new agents from reusable components. It's intended for systems that need lots of micro-agents working together, with little oversight but a clear security posture. Want to build a swarm of agents to expand your openclaw's reach? Need to run an agent in CI, that talks to the network, yet never have to worry about prompt injection? Do you just want to build a memory system and not have to worry about *everything* that goes into building an Agent harness? Then Loom is for you. 

Loom is based on Anthropic's [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents), with some adjustments to provide richer APIs:

- A **harness**, is responsible for acquiring tokens and dispatching tools. Loom ships with an Anthropic and OpenAI harness out of the box, but you can easily write your own for any other model provider. Have a local deepseek install? Want to talk to OpenRouter? Implement a `Harness`.
- A **session** owns your context window. Its job is to receive content updates from the **harness**, and turn them into a context window for the next invocation. **Sessions** are arranged into _layers_. Each layer can provide its own additions to the system prompt, tools, and processing of the messages it's seen. Loom will automatically call each one in turn when generating a context window or pushing a message. Loom uses these to implement core agent behavior as installable libraries.
- **Tools** are the foundation of any agent. They are the agent's only sense organs, as well as its only way to interact with the world. Loom allows you to configure tools individually but also provides a way to control tools with **capabilities**.
- **Capabilities** are a contextual description of what a tool may do. For example, a `read_file` tool has capabilities for describing which paths it can read, while a `send_discord_dm` tool has capabilities for describing which users it can send DMs to. Capabilities are closed, no other mechanism can add capabilities to a manifest. 
- A **provider**, is a library that supplies any of the above components. This could be a git repo, an npm package, or a local directory.
- Loom has first class support for **ACP**, and each component can implement their own parts of the protocol. However, Loom is primarily intended for non-interactive use cases.

Loom comes with a simple CLI for installing and running these agents:

- `$ loom install <agent.toml>` to resolve and install a harness from a manifest.
- `$ loom prompt <agent.toml> [text]` to send a prompt to a harness and run it for a single turn
- `$ loom run <agent.toml>` to run a simple client for interacting with the agent instantiated by the manifest 
- `$ loom audit <agent.toml>` to see the full list of every component that will be used to run a given agent.

## Security Model

Loom cannot, and does not attempt to, protect you from supply chain attacks. Think of using loom as similar to installing a library or a CLI tool. Loom providers have full access to your system, and are trusted to be responsible and honest in their interactions. Loom can only protect you from misbehaving agents, not misbehaving humans.

Loom is intended to allow you to safely run agents without monitoring the output for misbehavior. Loom does this by using capability security to control which resources each tool has access to _before_ it's been instantiated. Each tool uses a contextually appropriate capability scheme, defined and enforced by the tool itself. For example, a `bash` tool needs to be sandboxed to run safely. However, for a `read_discord_messages` tool, a sandbox is a distraction. The tool implicitly needs access to a network, and its capabilities are better described in terms of user or channel IDs. By defining capabilities at the tool level, both of these tools can coexist in the same agent harness without contradiction.

The capabilities declaration in the manifest forms a ceiling. In general, Loom goes for explicit and declarative configuration over implicit behavior. If you don't include _any_ value, Loom will attempt to use a smart and safe default. For example, if your manifest doesn't include a `[tools]` block, Loom will automatically add the same tools as [Pi](https://pi.dev): read_file, write_file, find, and bash, each scoped to the current working directory. However, as soon as you do include a `[tools]` block, Loom will only add the tools you specify, and any tools added by a provider.

To see the full list of providers, harnesses, sessions, tools, capabilities, and secrets that an agent manifest will use, run `loom audit <agent.toml>`

## Building a provider

Providers do everything interesting in Loom. Beyond implementing their own features, providers are responsible for accurately and honestly reporting what their dependencies are. If a harness or tool needs an API key, use your component's `secret` field to get it. 

Tools and sessions can also define functional dependencies that are automatically included when those tools and sessions are used. For example, building an [RLM](https://arxiv.org/abs/2512.24601) agent on Loom requires your session to provide tools for the agent to configure the context window of its sub-agents. Similarly, a spawn-subagent tool might require its own configuration, such as its own system prompt and a subset of tools. 

Subagents are a special case of functional dependencies. Generally, if your component wants to use an LLM for its features, it can use the harness directly. But if you want to spawn a small research subagent, for example, use the subagents field in your component's type. Loom will ensure that all of its dependencies (secrets, packages, etc.) are resolved and available to your tool. Simply use Loom's spawnSubagent method to create your subagent by name.

## Learning Loom

Claude has written a lot of documentation, but the main place to learn the entry points and common usage is the `examples/` directory. I'd recommend starting there, before diving into the rest of the codebase. Loom has a lot of basic application features that provider authors might want to use, secret resolution, automatic storage directory, etc. But at the end of the day, Loom is only as useful as the providers that are built into it. 

>[!NOTE]
> Everything below this message is written by an LLM

## Install

For now, build from source:

```sh
git clone https://github.com/<you>/loom.git
cd loom
npm install
npm run build
node dist/cli/main.js help
```

Requires Node 20 or newer.

---

## Quick start

The `examples/` directory has a working agent — a notes-taking
assistant with persistent recall across sessions, built on a small
custom provider package. From the repo root:

```sh
npm run build
(cd examples/notes-provider && npm run build)
loom audit examples/minimal-agent/agent.toml
```

`loom audit` prints the resolved capability tree — every provider,
every tool, every grant — without ever calling the model. Skim it
to see what the agent can do.

Then run it:

```sh
ANTHROPIC_API_KEY=... loom run examples/minimal-agent/agent.toml
```

In the REPL, tell the agent to remember something — a preference,
a name, a project convention. Quit with `/q`, then start it again
and ask what it knows about you. The notes from the previous
session are loaded into the prompt automatically.

From there, copy `examples/minimal-agent/agent.toml` and adjust the
manifest to your needs. The Examples section below catalogs what
else is in there.

---

## Examples

Everything in `examples/` is real, runnable, and audited under
`loom audit examples/minimal-agent/agent.toml`. The examples
directory is organized into four self-contained projects, each
with its own `README.md`:

| Directory | What it demonstrates |
|---|---|
| [`examples/minimal-agent/`](./examples/minimal-agent/) | **The declarative shape.** An agent with a 3-layer session (`compacting` → `notes` → `in-memory`), built-in tools, capability grants, and a local provider reference. |
| [`examples/sdk-agent/`](./examples/sdk-agent/) | **The imperative SDK shape.** Same agent as `minimal-agent/`, built in code. Demonstrates the heterogeneous session-array form (`session: [compactor, "notes", "in-memory"]`) — mix a hand-built `CompactingSession` instance with named layers the runtime resolves. The instance is what `/compact` and `/tokens` REPL commands reach into. Run with `npx tsx examples/sdk-agent/agent.ts`. |
| [`examples/mcp-agent/`](./examples/mcp-agent/) | **An MCP-driven agent**, paired with a stand-alone example MCP server. End-to-end tour of Loom's `mcp-server` meta-provider: rename, narrow, pre-bind, secret-inject. |
| [`examples/notes-provider/`](./examples/notes-provider/) | **A complete working provider package.** Contributes a single `NotesSession` that loads remembered facts from a markdown file into the system prompt every turn AND owns a `remember(fact)` tool the model uses to save new ones. ~280 lines. Consumed by both `minimal-agent/` and `sdk-agent/`. Demonstrates the session-as-Tools-provider pattern. |

---

## Using Loom as a library

Loom is also a TypeScript library. `runAgent(manifest)` accepts the
same shape as the TOML file, just as a JS object. You construct
primitives directly when you want a reference to them — e.g. to
hold an `AnthropicHarness` instance and reuse it across multiple
agents, or to wire a `CompactingSession` into a `/compact` slash
command.

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
  session: [                                          // layered
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

void (async () => {
  for await (const update of agent.updates()) {
    // render however you want — see examples/sdk-agent/agent.ts for a tiny renderer
  }
})();

await agent.prompt("hi");
await agent.close();
```

The manifest mixes spec form and instance form freely. Anywhere
you could write `{ provider = "...", ...config }` in TOML you can
pass either a spec object or a pre-built class instance — useful
for the harness and session slots when you want a direct reference
to the layers.

See [`examples/sdk-agent/agent.ts`](./examples/sdk-agent/agent.ts)
for a full working SDK setup including a tiny update renderer.

---

## Layered sessions

A session in Loom is either a single layer or a stack of layers.
The `Session` interface defines the composition protocol:

- **`push`** flows top-to-bottom. Each layer may transform, drop,
  or fan-out the event before the next layer sees it. The bottom
  layer is typically storage.
- **`pull`** flows bottom-to-top. Each layer receives what the
  layers below it produced and may rewrite it. The top is what the
  harness sees as the prompt.
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

A layer can also own a tool's implementation directly. A `Session`
that advertises a tool name via `tools()` AND implements
`resolveTool(name, config, agent, capabilities)` is treated as the
implicit Tools provider for that name — no separate `[tools.X]`
entry needed in the manifest. The notes example uses this to bundle
its `remember` verb with the session that stores it.

### Mixing pre-built instances into the chain (SDK only)

From code, the `session` array can be **heterogeneous**: any entry
can be a string, a `SessionSpec`, or a pre-built `Session` instance.
The runtime resolves the named entries and threads everything
through `ChainedSession`:

```ts
import {
  CompactingSession,
  modelCompactor,
  runAgent,
  type AgentManifest,
} from "loom";

const compactor = new CompactingSession({
  threshold: 60,
  compactor: modelCompactor(),
  onCompact: ({ before, after }) =>
    console.log(`[compacted] ${before} → ${after}`),
});

const manifest: AgentManifest = {
  // ...
  providers: { notes: { path: "./notes-provider" } },
  session: [
    compactor,        // pre-built Session instance, used verbatim
    "notes",          // resolved via [providers].notes
    "in-memory",      // built-in
  ],
  // ...
};

const agent = await runAgent(manifest);
// `compactor` is the same instance the runtime is driving:
await compactor.compactNow(harness);          // forced compaction
const used = compactor.tokensInContext;       // peek at usage
```

Reach for this when you need a **handle** to a specific layer —
wiring `compactor.compactNow()` to a `/compact` slash command, or
reading `tokensInContext` to show context-usage in your UI. With the
TOML form, the runtime owns every instance and nobody else can call
those methods.

For the singleton case (no chain, one hand-built session), pass the
instance directly: `session: someSession`. See
[`examples/sdk-agent/agent.ts`](./examples/sdk-agent/agent.ts) for
a complete working example.

---

## Capabilities reference

Every tool declares the capability *kinds* it needs (`requires`)
and those it may use if granted (`optional`). The manifest's
`[capabilities]` table grants them per-tool:

```toml
[capabilities]
bash       = { subprocess = "*", paths = ["./"], env = ["PATH", "HOME"] }
read_file  = { paths = ["./"] }
write_file = "*"                # whole-tool unrestricted
fetch_url  = "*"
```

### Grant shapes

| Shape | Meaning |
|---|---|
| `"*"` | Whole-tool unrestricted. Sandbox engagement opts out. |
| `{ kind = value }` | Per-kind, where `value` is `"*"`, an allowlist array (`["./src", "./test"]`), or a kind-defined object. |
| `{}` | Nothing granted. Tools with non-empty `requires` fail boot. |

### Kinds shipped by the built-in tools

| Kind         | Used by | Semantics |
|---|---|---|
| `paths`      | `read_file`, `write_file`, `find`, `bash` | `"*"` any FS; `["./"]` allowlist; absent → smart default |
| `subprocess` | `bash` | `"*"` allow exec; absent → deny |
| `network`    | `bash` | `"*"` allow; absent → deny |
| `env`        | `bash` | Two-tier inheritance — see below |

### Bash env inheritance

Bash inherits environment variables in two tiers:

- **Tier 1 — always inherited.** `HOME`, `USER`, `LOGNAME`, `SHELL`,
  `TERM`, `COLORTERM`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`. Locale
  and terminal plumbing; never overridable. A hermetic shell with
  broken locale and no `$HOME` isn't hermetic, it's broken.
- **Tier 2 — default-on, replaceable.** `PATH`, `PWD`, `TMPDIR`,
  `EDITOR`, `VISUAL`, `PAGER`. Included when `env` is absent;
  dropped when `env` is an explicit list.

| Grant | Result |
|---|---|
| `env` absent | Tier 1 + Tier 2 (the convenient default) |
| `env = "*"` | full `process.env` |
| `env = []` | Tier 1 only (hermetic-but-functional) |
| `env = ["NAME"]` | Tier 1 + `NAME` |
| `env = ["AWS_*"]` | Tier 1 + prefix match on `AWS_` |

### Subagent ceiling

`[capabilities]` is a transitive ceiling across the sub-agent tree:
every sub-agent's effective grants must be a subset of its parent's.
`loom audit` walks the whole tree statically and reports violations
before they hit at runtime.

---

## What's in the box

**Harnesses:** `anthropic`, `openai`, `test`, `small-model-of-parent`

**Sessions:** `in-memory`, `file`, `compacting`, `skills`,
`fork-of-parent`

**Tools:** `bash` (with macOS sandbox-exec / Linux bwrap profile
derivation), `read_file`, `write_file`, `find`, `spawn_subagent`

**Tools meta-factories:** `mcp-server` (any MCP server via the
configured-factory `[providers]` form; see the MCP section below)

**Secret stores** (chained, in order): a caller-supplied store, env
vars, XDG-spec `$XDG_CONFIG_HOME/loom/secrets`, the OS keychain (when
available), and a `.loom-secrets` file next to the manifest.

**Per-agent storage:** every agent gets one directory Loom guarantees
exists, surfaced to every plugin via `FactoryContext.storage`. Plugins
decide what to put there — cached tool lists, journals, notes files,
PID files — with no key-value abstraction layered on top. Layout:

| Platform | Path |
|---|---|
| macOS    | `~/Library/Application Support/Loom/agents/<id>/` |
| Linux    | `$XDG_DATA_HOME/loom/agents/<id>/` (`~/.local/share/loom/agents/<id>/` by default) |
| Windows  | `%APPDATA%/Loom/agents/<id>/` |

Override the root with `LOOM_DATA_HOME=<dir>` (useful for tests / CI /
sandboxed runs). The `<id>` defaults to `[agent].name`; set
`[agent].storage_id = "..."` to pin a stable identifier independent
of the agent's display name (handy when two manifests share state, or
should NOT share state despite sharing a name).

`loom audit <agent.toml>` prints the resolved storage path at the top
and surfaces any collision warning (two manifests opening the same
`storage_id` from different on-disk locations — legitimate but worth
flagging).

---

## MCP servers

Loom speaks MCP natively. Any
[Model Context Protocol](https://modelcontextprotocol.io) server —
the same ones Claude Desktop, Cursor, and Continue consume — plugs
into a Loom manifest through the built-in `mcp-server` Tools
meta-factory. There's no separate package to install; `mcp-server`
registers alongside `bash` / `read_file` / etc.

The shape is:

```toml
[providers]
# Configured-factory form: `provider = "mcp-server"` names the
# built-in factory; the rest of the table is server-spawn config
# (command/args/npm, env, secrets).
fs_mcp = { provider = "mcp-server", npm = "@modelcontextprotocol/server-filesystem" }
linear = { provider = "mcp-server", command = "npx", args = ["@linear/mcp-server"], secrets = { LINEAR_API_KEY = "LINEAR_API_KEY" } }

# Every tool the model can call MUST appear by name here.
# Static enumeration is the security review surface — no wildcard,
# no auto-import. Use `loom mcp inspect` to scaffold these.
[tools.read_text_file]
provider = "fs_mcp"

[tools.list_directory]
provider = "fs_mcp"

[capabilities]
read_text_file = { path = "*" }
list_directory = { path = "*" }
```

One `[providers]` handle = **one** MCP server process. Every
`[tools.X]` entry pointing at the handle dispatches against the
same `Tools` instance — the underlying MCP server is contacted
once, and `resolveTool(name, per_tool_config, …)` routes each
tool call. Per-tool config (`mcp_tool`, etc.) flows to
`resolveTool` only; it never affects which server gets spawned.

**Capability-based partial application.** The big win: each
`[capabilities]` per-arg grant doubles as a pre-binding. A literal
binding drops the arg from the model-visible schema and merges it
at execute time:

```toml
[tools.read_one_doc]
provider = "fs_mcp"
mcp_tool = "read_text_file"      # underlying MCP tool name

[capabilities]
read_one_doc = { path = "/path/to/welcome.md" }
```

The model sees `read_one_doc` as a **zero-argument** tool; Loom
supplies `path` transparently on every call. Same MCP tool can be
exposed under multiple model-facing names with different bindings
(`mcp_tool` rename + per-tool grant). Array grants narrow an arg
to an enum (`status = ["online", "away"]` → model can pick those
two only); `"*"` keeps an arg open; absent leaves it open too.

**Secrets in env.** Put `secrets = { LOOM_NAME = "ENV_VAR_NAME" }`
on the `[providers]` entry. The factory looks each key up in
Loom's secret store at boot and writes the value into the spawned
server's environment under the mapped name. Boot fails if any
listed secret is missing. (Secrets are spawn-level concerns; one
MCP server = one process = one env, so they live on the provider
entry, not on individual `[tools.X]` entries.)

**Authoring aid.** `loom mcp inspect <provider-spec>` spawns the
server, runs `tools/list`, kills the server, and prints a paste-and-
prune TOML snippet with one `[tools.X]` per advertised tool plus a
commented-out `[capabilities]` block. Spec shapes: an npm name
(`@scope/pkg`), a path (`./bin/server.mjs`), or a bare handle from
a manifest (`--manifest agent.toml`).

See [`examples/mcp-agent/`](./examples/mcp-agent/) for a complete
end-to-end tour with one MCP tool per integration feature — manifest
and stand-alone MCP server live in the same example project.

---

## Authoring a provider

The canonical working example is
[`examples/notes-provider/`](./examples/notes-provider/).
Read it alongside this section.

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

A session contribution can additionally implement
`resolveTool(name, config, agent, capabilities)` and Loom will
treat it as the implicit Tools provider for the names it
advertises via `tools()`. This is how the notes example bundles
its `remember` verb with the session that owns the state — no
separate `[tools.X]` entry, no duplicate config.

---

## CLI reference

| Command | What it does |
|---|---|
| `loom run <agent.toml>` | Interactive REPL with streaming markdown, slash commands (`/help`, `/audit`, `/tools`, `/events`), and history replay. |
| `loom prompt <agent.toml> [text] [--format <text\|trace\|jsonl>]` | One-shot prompt (`text` or stdin). Exits after the turn with a Unix-style code (`0` clean, `130` cancelled, `1` otherwise). `--format`: `text` (default) prints only the final agent message to stdout, pipe-friendly; `trace` prints a coalesced labelled view with tool calls + stop reason; `jsonl` emits one raw `SessionUpdate` per line. |
| `loom audit <agent.toml> [--json]` | Static capability tree. No model calls. Exits non-zero (with the partial tree printed) when the manifest isn't fully resolvable — unresolved sources, provider init failures, unresolved `[tools]` entries, missing required capabilities, capability ceiling violations, or `tool.audit()` error findings. |
| `loom acp serve <agent.toml>` | Speak [ACP][acp] over stdio. Pairs with any ACP-aware client. |
| `loom install [agent.toml]` | Materialise the manifest's npm/path sources into `.loom/node_modules/`. `--frozen` for CI. |
| `loom mcp inspect <provider-spec> [--manifest <agent.toml>] [--json]` | Spawn an MCP server, dump its tools as paste-and-prune TOML (or JSON). Provider spec is an npm name, a path, or a `[providers]` handle from `--manifest`. |
| `loom providers list` | List Loom provider packages discoverable from cwd. |
| `loom providers info <name>` | Show resolved metadata for a provider package. |

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
ANTHROPIC_API_KEY=... node dist/cli/main.js run examples/minimal-agent/agent.toml
# or via the SDK:
ANTHROPIC_API_KEY=... npx tsx examples/sdk-agent/agent.ts "your prompt here"
```

---

## License

MIT.
