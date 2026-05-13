# Loom

> A capability-secure, manifest-driven agent runtime.

>[!NOTE]
> Humans, start here:

Loom is a package manager and runtime for agent harnesses. Define
your agent's features and capabilities in an `agent.toml` manifest,
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

 # The four FS / shell tools auto-load when `[tools]` is absent;
 # `find` is built-in but opt-in. 
[tools]
bash       = "builtin"
read_file  = "builtin"
write_file = "builtin"
edit_file  = "builtin"
find       = "builtin"

# Use capabilities to define a flexible security model that fits your needs
[capabilities]
# Read files in this directory and another
read_file  = { paths = ["./", "../other-files"] }
find       = { paths = ["./", "../other-files"] }
# Writing + editing files is restricted to the current directory
bash       = { subprocess = "*", paths = ["./"] } # Sandboxed by default, no network access
write_file = { paths = ["./"] }
edit_file  = { paths = ["./"] }
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

The capabilities declaration in the manifest specifies the highest capabilities possible to grant. In general, Loom goes for explicit and declarative configuration over implicit behavior. If you don't include _any_ value, Loom will attempt to use a smart and safe default. For example, if your manifest doesn't include a `[tools]` block, Loom will automatically add the same tools as [Pi](https://pi.dev): read_file, write_file, edit_file, and bash, each scoped to the current working directory. However, as soon as you do include a `[tools]` block, Loom will only add the tools you specify, and any tools added by a provider.

To see the full list of providers, harnesses, sessions, tools, capabilities, and secrets that an agent manifest will use, run `loom audit <agent.toml>`

## Building a provider

Providers do everything interesting in Loom. Beyond implementing their own features, providers are responsible for accurately and honestly reporting what their dependencies are. If a harness or tool needs an API key, use your component's `secret` field to get it. 

Tools and sessions can also define functional dependencies that are automatically included when those tools and sessions are used. For example, building an [RLM](https://arxiv.org/abs/2512.24601) agent on Loom requires your session to provide tools for the agent to configure the context window of its sub-agents. Similarly, a spawn-subagent tool might require its own configuration, such as its own system prompt and a subset of tools. Harnesses also provide their own tools, e.g. a `web_search` tool, but these tools are not automatically included in the agent's manifest.

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

**Pass-through vs storage**. Some sessions are *pass-through*
layers — they transform / adorn events flowing through the chain
but don't themselves persist them (e.g. `compacting`, `skills`).
Others actually retain events (`in-memory`, `file`). Boot fails
with a clear error if every factory-based layer in the chain is
pass-through (no storage anywhere) — otherwise pushes would
propagate without anything to retain them and every turn would see
an empty history. Add a storage layer to the end of your chain.
Session authors flag their factories with `passThrough: true` when
they don't store events; default is storage-class, the safe default
for third-party sessions.

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
bash      = { subprocess = "*", paths = ["./"], env = ["PATH", "HOME"] }
read_file = { paths = ["./"] }
edit_file = "*"                # whole-tool unrestricted
fetch_url = "*"
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
| `paths`      | `read_file`, `write_file`, `edit_file`, `find`, `bash` | `"*"` any FS; `["./"]` allowlist; absent → smart default |
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

Loom ships four built-in registries: harness factories, session
factories, Tools meta-factories, and native tools. Everything below
is available with no install step; manifests reference them by
name, the SDK exposes the underlying classes for direct
construction.

### Harnesses

Referenced as `[harness].provider = "<name>"` (TOML) or
`{ provider: "<name>", ...config }` / `new XxxHarness(...)` (SDK).
Every harness factory declares the secrets it needs at boot via the
standard secrets pipeline.

#### `anthropic`

Claude via the Anthropic Messages API. Streams when `stream = true`
(default). Tool calls are dispatched through the runtime; the
harness handles the `tool_use` / `tool_result` round-trip.

| Config key | Default | Notes |
|---|---|---|
| `model` | `claude-sonnet-4-5-latest` | Any Anthropic model id. |
| `apiBase` | `https://api.anthropic.com` | Override for proxies / self-hosted. |
| `maxTokens` | `4096` | Per-response output cap. |
| `maxTurnRequests` | `16` | Tool-call round-trip safety limit per turn. |
| `stream` | `true` | When false, the response arrives as one block. |

- **Secrets:** `ANTHROPIC_API_KEY` (required).
- **ACP capabilities:** advertises `promptCapabilities.image` and
  `promptCapabilities.embeddedContext` at `initialize` time, so
  ACP clients know they can attach images and embedded resources.
- **SDK class:** `AnthropicHarness` (also implements `withModel(id)`
  and `smallModel()` for use under `small-model-of-parent`).

#### `openai`

OpenAI via the Responses API (the streaming successor to Chat
Completions). Same tool-dispatch shape as Anthropic.

| Config key | Default | Notes |
|---|---|---|
| `model` | `gpt-5.1` | Any OpenAI Responses-API-compatible model. |
| `apiBase` | `https://api.openai.com/v1` | Override for proxies / Azure / self-hosted. |
| `maxOutputTokens` | unset | Per-response output cap; omit to use server default. |
| `maxTurnRequests` | `16` | Tool-call round-trip safety limit per turn. |
| `stream` | `true` | When false, the response arrives as one block. |

- **Secrets:** `OPENAI_API_KEY` (required).
- **ACP capabilities:** same as `anthropic` (image + embeddedContext).
- **SDK class:** `OpenAIHarness` (also implements `withModel(id)`
  and `smallModel()`).

#### `small-model-of-parent`

**Sub-agent only.** Clones the parent agent's harness, swapping in
a cheaper / smaller model. Lets the parent reach into the runtime
for a routing decision or a one-off summary without burning the
full frontier model.

| Config key | Default | Notes |
|---|---|---|
| `model` | parent's `smallModel()` | Explicit id wins; otherwise the parent harness's recommendation is used. |

- **Secrets:** inherited from the parent's harness (no separate secret slot).
- **Requires:** parent harness must implement the optional
  `Harness.withModel(modelId)` method. Both built-in `AnthropicHarness`
  and `OpenAIHarness` do; third-party harnesses opt in by adding the method.
- **Boots only as a sub-agent** — used at the top level it fails at
  resolve time with a clear error.

#### `test`

A deterministic, scripted harness for testing the runtime and tool
plumbing without an LLM. Two modes:

- **Scripted:** `script: TurnStep[][]` (or a function returning
  `TurnStep[]`). Each turn consumes one inner script. Steps are
  `{ say }` / `{ think }` / `{ call: { tool, input } }` / `{ stop }`.
- **Echo:** `{ echo: true }` — replays the latest user message as an
  agent message and ends the turn. Useful for smoke tests.

- **Secrets:** none.
- **SDK class:** `TestHarness` (used heavily by Loom's own test
  suite — see `test/` for working examples).

### Sessions

Referenced as `[session].provider = "<name>"`, `[[session.layers]]`
entries, `{ provider: "<name>", ...config }`, bare strings in the
`session: [...]` array, or `new XxxSession(...)` (SDK).

When `manifest.session` is absent entirely, the runtime applies the
default chain `skills → compacting → in-memory` — bounded growth
and `~/.skills` auto-loading out of the box, with `skills` silently
no-opping when the directory is missing.

#### `in-memory`

The canonical leaf storage layer. Events live in a process-local
array; nothing is persisted. No config; every instance starts
empty. Use this as the innermost (bottom) link in a chain when you
don't need durability.

- **SDK class:** `InMemorySession`.

#### `file`

JSONL append log. Coalesces consecutive same-kind chunks
(`agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`)
into single events before writing, so the on-disk log stays compact
and readable.

| Config key | Default | Notes |
|---|---|---|
| `path` | **required** | Absolute or relative to manifest dir. |

Use as a drop-in replacement for `in-memory` when you want the
conversation to survive process exit.

- **SDK class:** `FileSession`.

#### `compacting`

A pull-side transform that summarises older events past a threshold.
Designed to sit **above** a storage layer in a chain. On push it's
a passthrough (events flow down to be stored) but it swallows
`usage_update` events so token usage stays as in-memory metadata
instead of cluttering the durable log.

| Config key | Default | Notes |
|---|---|---|
| `threshold` | `40` | Event-count threshold that trips compaction. |
| `tokenThreshold` | unset (SDK only) | Token-count threshold (uses latest `usage_update.used`); takes priority over `threshold` when usage data is available. |
| `keep` | `10` | Most recent events that survive verbatim. |
| `compactor` | `heuristicCompactor` (SDK only) | Replace with `modelCompactor()` for model-driven summarisation. |
| `onCompact` | none (SDK only) | Diagnostic callback fired after each successful compaction. |

Exports `compactingMemorySession()` and `compactingFileSession()`
as SDK helpers for the common chains. Hold a reference to the
`CompactingSession` instance (via the heterogeneous-array shape
above) to drive `compactNow()` imperatively from a slash command.

- **SDK class:** `CompactingSession`.
- **Pairs well with:** `modelCompactor({ instruction, systemPrompt, fallback })`.

#### `skills`

Discovers [Agent Skills](https://agentskills.io) folders (directories
with a `SKILL.md` YAML-frontmatter file) and contributes them to the
agent in three ways: a system-prompt section listing the available
skills, trusted-path entries for each root (so read-oriented tools
can see them without an explicit grant), and aggregated required-tool
requests.

| Config key | Default | Notes |
|---|---|---|
| `root` / `roots` | `~/.skills` | One root or many. Relative paths resolve against manifest dir; `~` expands to OS home; missing roots are silently skipped. |
| `default_tools` | `["bash"]` | Tools registered for skills that don't declare `metadata.loom.required-tools`. Pass `[]` to opt out. |

Rescans roots each turn so mid-conversation additions are picked
up. Skills with malformed frontmatter are skipped quietly so boot
stays resilient.

- **SDK class:** `SkillsSession`.

#### `fork-of-parent`

**Sub-agent only.** Snapshots the parent's events into a fresh
`InMemorySession` at fork time. Subsequent appends on either side
don't bleed across — the sub-agent gets the parent's context as a
starting point and writes its own log from there. No config.

### Tools meta-factories

Referenced in `[providers].<handle> = { provider = "<name>", ... }`.
A meta-factory is a Tools provider the runtime can instantiate by
name (no on-disk package needed). The same instance can back many
`[tools.X]` entries.

#### `mcp-server`

Any [Model Context Protocol](https://modelcontextprotocol.io) server
— stdio transport, spawned + adapted. One `[providers]` entry per
server instance; one `[tools.X]` entry per exposed tool. Tools can
be renamed (`mcp_tool = "original_name"`), narrowed (capability
grant binds args), and constrained by enum (array grant). See the
full section below for the integration tour.

| Config key | Default | Notes |
|---|---|---|
| `command` + `args` | required (or `npm`) | Generic stdio launcher. |
| `npm` | required (or `command`) | Shorthand for npm-distributed servers. Equivalent to `command = "npx"` + `args = ["-y", "<pkg>"]`. |
| `env` | none | Static env vars passed to the spawned process. |
| `secrets` | `{}` | Map of `LOOM_SECRET_NAME = "ENV_VAR_NAME"`. Each LHS is resolved through Loom's secret store and injected into the child's env under the RHS name. Per-instance, marked as required at Phase 1. |

Use `loom mcp inspect <spec>` to discover a server's tool list as
paste-and-prune TOML (see CLI reference).

### Native tools

Referenced as `[tools.<name>] = "builtin"` or omitted entirely (the
four file-system tools are auto-loaded with default capabilities
when `[tools]` is absent). Every tool has a static capability
requires/optional contract; manifest grants must cover the
`requires` set for boot to succeed.

#### `bash`

Execute a shell command via `/bin/bash -c`. Engages the platform
sandbox (`sandbox-exec` on macOS, `bwrap` on Linux) when the grant
is structured, with the profile derived from the same grant the
model sees — one source of truth for both the model's mental model
and the OS-level confinement.

| Input field | Type | Notes |
|---|---|---|
| `command` | string (required) | The command to run. |
| `cwd` | string | Working directory; must be inside an allowed path. |
| `timeout_ms` | number | Default 30000. |

- **Capability kinds:** requires `subprocess`; optional `paths`, `network`, `env`.
- **Sandbox profile** is derived from the grant — a structured
  grant engages the sandbox; `"*"` opts out (no confinement).

#### `read_file`

Read a file's contents as UTF-8.

| Input field | Type | Notes |
|---|---|---|
| `path` | string (required) | Resolved against cwd unless absolute. Must be inside an allowed path. |

- **Capability kinds:** optional `paths` (defaults to `["./"]` when
  `[tools]` is omitted entirely; otherwise an explicit grant is
  required).

#### `write_file`

Write a UTF-8 file in full. Use this to **create new files** or
**wholesale-replace** existing ones. For targeted changes to an
existing file, prefer `edit_file` — it's much more efficient (no
need to repeat the unchanged bulk of the file) and produces a diff
in the wire `tool_call_update` for IDE-client rendering.

| Input field | Type | Notes |
|---|---|---|
| `path` | string (required) | Resolved against cwd unless absolute. |
| `content` | string (required) | Full file contents. |
| `append` | bool | Append instead of overwriting. Default false. |
| `create_dirs` | bool | Create missing parent dirs. Default false. |

- **Capability kinds:** optional `paths`.
- **ACP routing:** when the client advertises `fs.writeTextFile`,
  the write goes through the editor (surfaces as an in-editor change
  with diff + approval UI). `append` / `create_dirs` fall back to
  local `fs` since ACP's `fs/writeTextFile` is full-file-replacement
  only.

#### `edit_file`

Modify an existing UTF-8 file by exact text replacement. The model
passes one or more `{ old_text, new_text }` pairs; each `old_text`
must match a **unique** substring of the file's current content.
All replacements apply against the *original* file, not
incrementally — the model doesn't have to reason about how earlier
edits shifted positions. Overlapping or nested matches are
rejected. The wire `tool_call_update` carries an ACP `Diff` content
block so IDE clients render an inline before/after view.

| Input field | Type | Notes |
|---|---|---|
| `path` | string (required) | Resolved against cwd unless absolute. Must exist. |
| `edits` | `{ old_text, new_text }[]` (required, non-empty) | Each `old_text` unique in the file. |

- **Capability kinds:** optional `paths`.
- **No file creation.** `edit_file` refuses to create new files; use
  `write_file` (or `bash` with a heredoc) when the file doesn't yet
  exist. Keeps the model's mental model simple — a missing file is a
  clear error rather than a silent new-file creation.

#### `find`

Glob-walk a directory tree. Opt-in built-in — list `find = "builtin"`
in `[tools]` to pull it in (`bash` covers most of what you'd reach
for `find` for, so the default set leaves it out).

| Input field | Type | Notes |
|---|---|---|
| `pattern` | string (required) | Glob (`**/*.ts`, `src/*.md`, etc.). `*` matches non-`/` chars; `**` matches any depth. |
| `root` | string | Root to walk. Default `.`. |
| `limit` | number | Max results. Default 200. |

- **Capability kinds:** optional `paths`.
- The wire `tool_call_update` is annotated with `kind: "search"`
  and a per-invocation title (`find <pattern>`) so IDE clients
  render the right icon.

#### `spawn_subagent`

Run a sub-agent for one turn and return its final assistant
message. Two modes:

1. **Self-copy** (default, no config). The sub-agent is a structural
   copy of the owning agent's manifest, with `spawn_subagent` itself
   stripped from `[tools]` and `[capabilities]` so the recursion
   bottoms out one level deep. Each spawned copy shares storage with
   the parent by default (same `name` / `storageId`). This is the
   simplest way to give an agent a "think harder / fan out" verb —
   the clone runs with the same harness, session config, and tools.
2. **Configured sub-manifest** (explicit). The sub-agent's manifest
   lives in the tool's config; the clone is whatever you wrote.

Either way, the resolved sub-manifest is recorded in
`tool.dependencies.subagents` so `loom audit` walks it (audit cycle
detection handles trivial loops; self-copy avoids them by stripping
`spawn_subagent` from the clone). The runtime enforces the
capability ceiling — the sub-agent's `[capabilities]` must be a
subset of the parent's grant for every tool the sub-agent uses
(trivially satisfied for self-copies).

| Input field | Type | Notes |
|---|---|---|
| `prompt` | string (required) | The user message to send to the sub-agent. |

- **Config (TOML):** omit entirely (or `spawn_subagent = "builtin"`)
  for the self-copy default; or `[tools.spawn_subagent] manifest = "./sub.toml"` /
  inline `manifest = { ... }` for an explicit sub-manifest.
- **No capability requirements of its own** — the ceiling check
  bounds what the sub-agent's tools can do, regardless of what
  `spawn_subagent` is granted.

Example (self-copy):

```toml
[tools]
spawn_subagent = "builtin"
bash           = "builtin"

[capabilities]
spawn_subagent = "*"
bash           = { subprocess = "*", paths = ["./"] }
```

With that manifest, calling `spawn_subagent({ prompt: "..." })`
spawns a fresh copy of the same agent (with `bash` still available
to the copy, but no further `spawn_subagent` so it can't fork
recursively).

#### `web_search`

Two flavours ship: a portable Brave-backed builtin (works with any
harness, billed on Brave), and harness-exposed server tools that
ride on the model provider's own search infrastructure (currently
Anthropic's `web_search` / `web_fetch`, billed on the Anthropic
API). The flavours are mutually exclusive per manifest — pick one
by setting `provider`:

| `provider =` | Path | Bill | Works with |
|---|---|---|---|
| `"builtin"` | Brave LLM Context API | Brave (`BRAVE_SEARCH_API_KEY`) | any harness |
| `"anthropic"` | Anthropic server tool (`web_search_20250305`) | Anthropic API | Anthropic harness only |

The harness-exposed flavour is the lower-friction option when
you're already on Claude (one less API key, model gets
`encrypted_content` back for citation re-grounding on subsequent
turns). Use `loom providers list` to see which harness-exposed
server tools your installed harnesses publish; opt in via
`provider = "<harness-name>"` in `[tools]`. See
`examples/full-agent/agent.toml` for both flavours side-by-side.

The rest of this section documents the **Brave builtin**. The
harness-exposed variants take a tiny subset of these knobs
(`max_uses`, plus `blocked_domains` and `user_location` for
`web_search`; `max_uses`, `max_content_tokens`, `blocked_domains`,
`citations` for `web_fetch`). `allowed_domains` is exposed as a
capability on the harness path (declare it in `[capabilities]` so
the manifest carries an explicit allow-list).

Searches the web via the [Brave LLM Context API](https://api-dashboard.search.brave.com/documentation/services/llm-context).
Returns pre-extracted, snippet-formatted results designed for LLM
grounding — no scraping, no token-budget surprises. Rendered as
markdown the model can consume directly (one section per result,
plus dedicated POI/Places sections when local recall is on).

| Input field | Type | Notes |
|---|---|---|
| `query` | string (required) | Max 400 chars, ~50 words. Natural language; the API ranks for grounding, not keyword match. |
| `freshness` | string | `pd` (24h), `pw` (7d), `pm` (31d), `py` (365d), or `YYYY-MM-DDtoYYYY-MM-DD`. Overrides the configured default. |
| `count` | integer (1-50) | How many results to consider. Overrides the configured default. |

- **Secrets:** requires `BRAVE_SEARCH_API_KEY` (the secret name is
  overridable via the `secret_name` config).
- **No capability kinds.** The tool only ever talks to one host
  (`api.search.brave.com`), so there's no useful manifest-grant
  surface. Tunables live in `[tools.web_search]` instead.
- **Defaults:** with no `[tools.web_search]` block, only `q` is sent
  and Brave's server-side defaults apply (`count=20`,
  `maximum_number_of_tokens=8192`, `context_threshold_mode=balanced`,
  `country=us`, `search_lang=en`, no freshness filter).

| Config key | Maps to Brave param | Range |
|---|---|---|
| `count` | `count` | 1-50 |
| `freshness` | `freshness` | `pd` / `pw` / `pm` / `py` / `YYYY-MM-DDtoYYYY-MM-DD` |
| `country` | `country` | 2-char code |
| `search_lang` | `search_lang` | 2+ char code |
| `max_urls` | `maximum_number_of_urls` | 1-50 |
| `max_tokens` | `maximum_number_of_tokens` | 1024-32768 |
| `max_snippets` | `maximum_number_of_snippets` | 1-100 |
| `max_tokens_per_url` | `maximum_number_of_tokens_per_url` | 512-8192 |
| `max_snippets_per_url` | `maximum_number_of_snippets_per_url` | 1-100 |
| `threshold_mode` | `context_threshold_mode` | `strict` / `balanced` / `lenient` / `disabled` |
| `enable_local` | `enable_local` | bool |
| `goggles` | `goggles` | URL or inline definition |
| `endpoint` | — | Override the API endpoint (useful for tests). |
| `secret_name` | — | Secret to read the API key from (default `BRAVE_SEARCH_API_KEY`). |

Example:

```toml
[tools]
web_search = "builtin"

[tools.web_search]
provider       = "builtin"
count          = 10
freshness      = "pm"
threshold_mode = "strict"
max_tokens     = 4096
```

```sh
BRAVE_SEARCH_API_KEY=... loom run agent.toml
```

### Manifest env-var substitution

The parser substitutes `${VAR}` and `${VAR:-default}` references in
string values at parse time. Variable names are POSIX-shaped
(letters / digits / underscores, can't start with a digit); braces
are required (no bare `$VAR`).

```toml
[agent]
name = "glass"
system_prompt = "vault lives at ${VAULT_PATH:-~/Dropbox/glass-vault}"

[harness]
provider = "anthropic"
model = "${MODEL_ID:-claude-sonnet-4-5}"

[capabilities]
read_file = { paths = ["${VAULT_PATH}", "./local"] }
```

An undefined required reference (`${NAME}` with no `:-default`)
throws `ManifestError` at parse time, naming the variable. Defaults
let you ship a manifest that works out of the box and still allow
an operator to override per environment.

**Not for secrets.** Substitution bakes values into the manifest
object, which then flows through audit / log paths and any tooling
that introspects the manifest — fine for paths and model ids,
wrong for API keys. Credentials go through the secret store (next
section), which carries per-tool filtering and no-log semantics.

SDK consumers can apply the same substitution to programmatic
manifests via `substituteEnv(manifest)` exported from `@mcmaki/loom`.

### Secret stores

Chained in order; the first store with a hit wins:

1. **Caller-supplied store** — `runAgent(manifest, { secrets })`.
2. **Environment variables** — `process.env[NAME]`.
3. **XDG file** — `$XDG_CONFIG_HOME/loom/secrets` (KEY=value lines).
4. **OS keychain** — macOS Keychain / libsecret / Windows Credential Manager.
5. **Per-manifest file** — `.loom-secrets` next to the manifest.

The SDK exports each layer (`EnvSecretsStore`, `FileSecretsStore`,
`XDGSecretsStore`, `KeychainSecretsStore`, `StaticSecretsStore`,
`ChainedSecretsStore`) so you can compose your own pipeline.

### Per-agent storage

Every agent gets one directory Loom guarantees exists, surfaced to
every plugin via `FactoryContext.storage`. Plugins decide what to
put there — cached tool lists, journals, notes files, PID files —
with no key-value abstraction layered on top. Layout:

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
two only); `"*"` keeps an arg open. **A per-arg map is a strict
whitelist** — anything the MCP server advertises but the manifest
doesn't name disappears from the model-visible schema. Use
whole-tool `"*"` to inherit the upstream schema as-is; `assertRequires`
rejects boot when a required MCP arg isn't satisfied (literal-bound,
enum-narrowed, or kept open with `"*"`).

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
| `loom prompt <agent.toml> [text] [--format <text\|trace\|jsonl>] [--emit-preamble]` | One-shot prompt (`text` or stdin). Exits after the turn with a Unix-style code (`0` clean, `130` cancelled, `1` otherwise). `--format`: `text` (default) prints only the final agent message to stdout, pipe-friendly; `trace` prints a coalesced labelled view with tool calls + stop reason; `jsonl` emits one raw `SessionUpdate` per line. `--emit-preamble` (jsonl only) prepends one `{ "preamble": { systemPrompt, events, tools } }` line capturing exactly what the model is about to see — useful for per-turn audit logging. |
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
