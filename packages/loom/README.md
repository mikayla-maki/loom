# Loom

> A capability-secure, manifest-driven agent runtime.

[![npm version](https://img.shields.io/npm/v/@mcmaki/loom.svg)](https://www.npmjs.com/package/@mcmaki/loom)
[![npm downloads](https://img.shields.io/npm/dm/@mcmaki/loom.svg)](https://www.npmjs.com/package/@mcmaki/loom)
[![license](https://img.shields.io/npm/l/@mcmaki/loom.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@mcmaki/loom.svg)](https://nodejs.org)

> [!NOTE]
> Humans, start here:

Loom is a package manager and runtime for agent harnesses. Define
your agent's features and capabilities in an `agent.toml` manifest,
install any skills as you need, check what it can do via `loom audit`,
then prompt it via `loom prompt`:

```toml
[agent]
name = "example-agent"
system_prompt = "You are a helpful assistant."

[harness]
provider = "anthropic" # This harness will inform Loom it needs an ANTHROPIC_API_KEY
model    = "claude-sonnet-4-5"

# Context management as composable layers.
[session]
layers = ["skills", "compacting", "in-memory"]

# Tools carry their own capabilities.
# Each builtin is sandboxed to exactly what you grant.
[tools]
read_file  = { capabilities = { paths = ["./"] } }
write_file = { capabilities = { paths = ["./"] } }
edit_file  = { capabilities = { paths = ["./"] } }
bash = { capabilities = [
  { commands = "*", paths = ["./"] },        # any command: this dir, no network
  { commands = ["gcalcli"], network = "*" }, # gcalcli alone may reach the network
] }
```

Skills plug into the capability system. A skill is a folder with a `SKILL.md`
that can declare the tools and grants it needs — Loom activates it only
if its request fits what your `agent.toml` allows:

```md
---
name: calendar
description: Read and add Google Calendar events with gcalcli.
metadata:
  loom.tools: |
    bash = { capabilities = { commands = ["gcalcli"], network = "*" } }
---
Use `gcalcli agenda`...
```

## Install

Install the CLI globally (requires Node ≥ 20):

```sh
npm install -g @mcmaki/loom
```

Or run it without installing:

```sh
npx @mcmaki/loom run agent.toml
```

To use Loom as a library in your own project:

```sh
npm install @mcmaki/loom
```

Then point it at your manifest:

```sh
ANTHROPIC_API_KEY=... loom run agent.toml
```

> **Status: early.** I've burned a lot of tokens on this project, and the provider
> APIs are likely to be stable. However, as I discover new use cases, the APIs will
> likely expand. This project has been entirely vibe coded, so don't trust it with your production data just yet :)

---

## Why Loom

Loom is a package manager for agents, that lets you spin up new agents from reusable components. It's intended for systems that need lots of micro-agents working together, with little oversight but a clear security posture. Want to build a swarm of agents to expand your openclaw's reach? Need to run an agent in CI, that talks to the network, yet never have to worry about prompt injection? Do you just want to build a memory system and not have to worry about _everything_ that goes into building an Agent harness? Then Loom is for you.

Loom is based on Anthropic's [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents), with some adjustments to provide richer APIs:

- A **harness**, is responsible for acquiring tokens and dispatching tools. Loom ships with an Anthropic and OpenAI harness out of the box, but you can easily write your own for any other model provider. Have a local deepseek install? Want to talk to OpenRouter? Implement a `Harness`.
- A **session** owns your context window. Its job is to receive content updates from the **harness**, and turn them into a context window for the next invocation. **Sessions** are arranged into _layers_. Each layer can provide its own additions to the system prompt, tools, and processing of the messages it's seen. Loom will automatically call each one in turn when generating a context window or pushing a message. Loom uses these to implement core agent behavior as installable libraries.
- **Tools** are the foundation of any agent. They are the agent's only sense organs, as well as its only way to interact with the world. Loom allows you to configure tools individually but also provides a way to control tools with **capabilities**.
- **Capabilities** are a contextual description of what a tool may do. For example, a `read_file` tool has capabilities for describing which paths it can read, while a `send_discord_dm` tool has capabilities for describing which users it can send DMs to. Capabilities are closed, no other mechanism can add capabilities to a manifest.
- A **provider**, is a library that supplies any of the above components. This could be a git repo, an npm package, or a local directory.
- Loom has first class support for **ACP**, and each component can implement their own parts of the protocol.

Together, these pieces let you define the dependencies and configuration for a single agentic turn. To do more than one turn, you need to build a client that calls loom multiple times.

## The client

Loom ships with a simple, no-frills CLI for debugging or interacting with an agent:

- `$ loom install <agent.toml>` to resolve and install a harness from a manifest.
- `$ loom prompt <agent.toml> [text]` to send a prompt to a harness and run it for a single turn
- `$ loom run <agent.toml>` to run a simple client for interacting with the agent instantiated by the manifest
- `$ loom audit <agent.toml>` to see the full list of every component that will be used to run a given agent.

Loom is intended to be embedded in a larger agent system, called a "client", that orchestrates the loom invocations. This could be a discord bot, a multi agent system, a coding CLI, or anything else that needs to safely build and invoke an agent turn.

## Security Model

Loom uses a capability-based security model, where its features and its security properties are one and the same. In loom, all agent security flows from the tools. These are the only mechanism the agent has for interacting with the world and so are the best location from which to define security boundaries. Loom cannot, and does not attempt to, protect you from supply chain attacks. Think of using loom as similar to installing a library or a CLI tool. Tool implementations have full access to your system, and are trusted to be responsible and honest in their interactions. Loom can only protect you from misbehaving agents, not misbehaving humans.

Loom uses capability security to both define and control which resources each tool has access to _before_ it's been instantiated. Each tool uses a contextually appropriate capability scheme, defined and enforced by the tool itself. For example, Loom's `bash` tool wraps each invocation in it's own sandbox. However, for a `read_discord_messages` tool, a sandbox is a distraction. The tool implicitly needs access to a network, and its capabilities are better described in terms of user or channel IDs. By defining capabilities at the tool level, both of these tools can coexist in the same agent harness without contradiction. 

Capabilites are a positive declaration of access. If it's not granted in the capability definition, the tool will not have access to the resource. While simple, this approach is powerful for defining fine-grained access control without needing to write complex permission logic. We use this feature extensively to manage the complexity of the tools provided by the MCP spec. We can filter the tools exposed to a useful subset, partially apply tool arguments so agents can only provide the arguments they need to, and render all of these policies visible by the capability grant section. However, per-tool capabilities on their own are not sufficient for complex permission logic. 

So far we've been talking about composition _across_ tools, but for composition _within_ tools we have another feature: _capability sets_. These allow you to apply _multiple_ capabilities to a single tool, as long as the tool is able to support them. Our bash tool uses this extensively to provide a flexible and fine-grained sandboxes via the `commands` capability. A simple `{ commands = "*" }` grant gives you full access to the shell without any network access, but if you pair that with a `{ commands = [ "gcalcli" ], network = "*" }` grant, the bash tool will _only_ allow gcalcli to access the network. It does this by shadowing the `gcalcli` binary with a shim that connects to a socket, leading to a broker process _outside_ of the sandbox. That broker process has a whitelist of allowed commands (driven by the `commands` capability set), and it spawns a _second_ sandbox, just for the capabilities granted to the `gcalcli` command. The broker then hands whatever results it gets back to the shim, letting the in-sandbox process continue as if the command had completed locally. Because the bash tool supports capability sets, we can define powerful primitives for running commands, letting you safely compose agent features without worrying about what they can get up to. We use this to support the agent skills spec in a safe and flexible way. Check out the skills agent example for more.

Capabilities are always tied to the tools that define them. When adding tools to your Agent.toml, you specify the capabilities you want for each tool, as part of the tool's configuration. However, the tools you define aren't the whole picture. To be useful, agents must compose tools from multiple different sources together, such as memory tools tied to your session storage, or tools implied by a specific skill. As such, the Agent.toml contains an additional `[capabilities]` section, that lets you control the overall capabilities that your agent is allowed to access, in terms of the tools added to your manifest by all of your dependencies. This is a strict _ceiling_. As long as you trust your tool implementations, loom will never let you run an agent with capabilities not covered by your `[capabilities]` section.

If you don't include any `[tools]` or `[capabilities]` section, Loom will provide the same tools as [Pi](https://pi.dev): read_file, write_file, edit_file, and bash, each scoped to the current working directory. To see the full list of providers, harnesses, sessions, tools, capabilities, and secrets that an agent manifest will use, run `loom audit <agent.toml>`.

Taken together, Loom's capability security model gives you leverage over the complexity of the AI ecosystem. You can safely install skills from anywhere on the internet, use MCP tools without blowing up context windows, and audit the whole security surface with a single command. All within a pluggable, modular architecture that lets you swap in new features as you see fit. The security model _is_ the feature set.

## Building a provider

Providers do everything interesting in Loom. Beyond implementing their own features, providers are responsible for accurately and honestly reporting what their dependencies are. If a harness or tool needs an API key, use your component's `secret` field to get it.

IMPORTANT: A tool's `containsGrant` and `mergeGrants` methods define its _capability algebra_. Loom provides a simple default, but many tools will want to provide a custom implementation for their domain.  The soundness of these two methods rests on them forming a _lattice_, `containsGrant` a partial order and  `mergeGrants` its least upper bound. Loom cannot provide it's capability checks if these methods are incorrect. As such, Loom property-checks these two methods on every agent boot, and uses the `sampleGrant` method to generate random values that conform to your tool's grant schema. `loom audit` will highlight if this sample method isn't implemented. Loom will refuse to run if the property check does not pass.

Tools and sessions can also define functional dependencies that are automatically included when those tools and sessions are used. For example, building an [RLM](https://arxiv.org/abs/2512.24601) agent on Loom requires your session to provide tools for the agent to configure the context window of its sub-agents. Similarly, a spawn-subagent tool might require its own configuration, such as its own system prompt and a subset of tools. Harnesses also provide their own tools, e.g. a `web_search` tool, but these tools are not automatically included in the agent's manifest.


Subagents are a special case of functional dependencies. Generally, if your component wants to use an LLM for its features, it can use the harness directly. But if you want to spawn a small research subagent, for example, use the subagents field in your component's type. Loom will ensure that all of its dependencies (secrets, packages, etc.) are resolved and available to your tool. Simply use Loom's spawnSubagent method to create your subagent by name.

## Learning Loom

Claude has written a lot of documentation, but the main place to learn the entry points and common usage is the `examples/` directory. I'd recommend starting there, before diving into the rest of the codebase. Loom has a lot of basic application features that provider authors might want to use, secret resolution, automatic storage directory, etc. But at the end of the day, Loom is only as useful as the providers that are built into it.

# Docs

> [!NOTE]
> Everything below this message is written by an LLM, intended for agents

## Building from source

To hack on Loom itself or run the examples from a checkout (rather
than the published package — see [Install](#install) above):

```sh
git clone https://github.com/mikayla-maki/loom.git
cd loom
npm install
npm run build
node dist/cli/main.js help
```

Requires Node 20 or newer.

---

## Quick start

`examples/minimal-agent/` is a single `agent.toml` — the built-in
file/shell tools scoped to the current directory, behind an
Anthropic harness. No provider package, no build step. Audit it
first:

```sh
loom audit examples/minimal-agent/agent.toml
```

`loom audit` prints the resolved capability tree — every provider,
every tool, every grant — without ever calling the model. Skim it
to see exactly what the agent can do. Then run it:

```sh
ANTHROPIC_API_KEY=... loom run examples/minimal-agent/agent.toml
```

Read that manifest top to bottom and you understand the agent; copy
it and adjust to your needs. When you want **persistent recall
across sessions**, look at `examples/full-agent/` — the same shape
plus a notes provider: tell it to remember something, quit with
`/q`, restart, and ask what it knows. The Examples section below
catalogs the rest.

---

## Examples

Everything in `examples/` is real, runnable, and auditable with
`loom audit <dir>/agent.toml`. Six self-contained projects, each
with its own `README.md`:

| Directory                                                | What it demonstrates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`examples/minimal-agent/`](./examples/minimal-agent/)   | **Start here.** The smallest useful agent: built-in file/shell tools scoped to the cwd, a two-layer session, capability grants — one `agent.toml`, no provider, no build step.                                                                                                                                                                                                                                                                                                                            |
| [`examples/full-agent/`](./examples/full-agent/)         | **The declarative shape, fully loaded.** A notes-taking assistant with persistent recall: a 3-layer session (`compacting` → `notes` → `in-memory`), built-in tools, harness-exposed web search, and a local provider reference.                                                                                                                                                                                                                                                                           |
| [`examples/sdk-agent/`](./examples/sdk-agent/)           | **The imperative SDK shape.** The same agent as `full-agent/`, built in code. Demonstrates the heterogeneous session-array form (`session: [compactor, "notes", "in-memory"]`) — mix a hand-built `CompactingSession` instance with named layers the runtime resolves. The instance is what `/compact` and `/tokens` REPL commands reach into. Run with `npx tsx examples/sdk-agent/agent.ts`.                                                                                                            |
| [`examples/mcp-agent/`](./examples/mcp-agent/)           | **An MCP-driven agent**, paired with a stand-alone example MCP server. End-to-end tour of Loom's `mcp-server` meta-provider: rename, narrow, pre-bind, secret-inject.                                                                                                                                                                                                                                                                                                                                     |
| [`examples/skills-agent/`](./examples/skills-agent/)     | **Agent Skills as contributed tool groups.** A five-skill tour, one skill per tier: pure instructions (authority-free, activated via `read_skill`), a frontmatter `loom.tools` bash row, a `loom.toml` sidecar declaring a renamed instance, a skill **shipping its own MCP server** via `loom.providers` (accepted by the instance-name `echo_note = "*"` consent line in `agent.toml`), and a deliberately rejected skill so `loom audit` shows the fail-soft verdict with its paste-ready remediation. |
| [`examples/notes-provider/`](./examples/notes-provider/) | **A complete working provider package.** Contributes a single `NotesSession` that loads remembered facts from a markdown file into the system prompt every turn AND owns a `remember(fact)` tool the model uses to save new ones. ~280 lines. Consumed by both `full-agent/` and `sdk-agent/`. Demonstrates session-implemented tools (a contributed tool group with the reserved `provider = "session"`).                                                                                                |

---

## Using Loom as a library

Loom is also a TypeScript library. `runAgent(manifest)` accepts the
same shape as the TOML file, just as a JS object. You construct
primitives directly when you want a reference to them — e.g. to
hold an `AnthropicHarness` instance and reuse it across multiple
agents, or to wire a `CompactingSession` into a `/compact` slash
command.

```ts
import { AnthropicHarness, runAgent, type AgentManifest } from "loom";

const harness = new AnthropicHarness(
  "claude-sonnet-4-5",
  process.env.ANTHROPIC_API_KEY!,
  "https://api.anthropic.com",
  4096,
  16,
  true,
);

const manifest: AgentManifest = {
  name: "demo",
  systemPrompt: "You are a helpful assistant.",
  harness, // instance, not spec
  session: [
    // layered
    { provider: "compacting", threshold: 60 },
    { provider: "file", path: "./demo.jsonl" },
  ],
  tools: { bash: "builtin", read_file: "builtin" },
  capabilities: {
    bash: { commands: "*", paths: ["./"] },
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

### Embedding Loom: framing, progress, steering

Hosts that drive their own UI or event model off `agent.updates()` get four
affordances beyond the ACP wire updates:

**Lifecycle frames.** The stream interleaves non-wire
`{ sessionUpdate: "frame", frame, role?, messageId? }` events:
`turn_start`/`turn_end` around each `prompt()`, and
`message_start`/`message_end` around the user message and each assistant
message (emitted by the harness). `messageId` correlates chunks to their
message. An assistant `message_end` always precedes execution of any tool
that message called — hosts can rely on it as a barrier. Frames flow through
`session.push` so layers can observe them, but storage layers do not persist
them, and the ACP server strips them from the wire.

**Tool progress.** Tools may call `ctx.progress?.({ content, title?,
rawOutput? })` to publish interim output; subscribers see a
`tool_call_update` with `status: "in_progress"`. Progress is ephemeral — it
never reaches the session, so replay never depends on it.

**Lossless subscriptions.** `agent.updates({ capacity: "unbounded" })`
disables the default drop-oldest bound (1024). Use it when a dropped update
would corrupt host state; the default bound remains right for debugging
renderers.

**Steering.** `agent.steer(prompt)` injects user content into the running
turn without cancelling it. It delegates to `Harness.steer` (implemented by
the `anthropic`, `openai`, and `test` harnesses, optional for custom ones):
queued blocks are drained after the current tool batch completes — or at the
start of the next turn when idle — and enter history as ordinary framed
`user_message_chunk`s. Overlapping `prompt()` calls remain the
cancel-and-restart path.

### Building terminal-style tools

A tool's `execute(input, ctx)` has everything a rich, long-running terminal
tool needs:

- **Live streaming.** Call `ctx.progress?.({ content, title?, rawOutput? })`
  as output arrives. Each call emits a `tool_call_update` with
  `status: "in_progress"` to subscribers only — progress is ephemeral and
  never persisted, so replay never depends on it. Throttle it (the built-in
  `bash` flushes at most every 100ms) and send the cumulative tail, not
  deltas.
- **Cancellation.** `ctx.abortSignal` fires on `agent.cancel()`; kill the
  process (and its tree) from the abort handler.
- **Output discipline.** `OutputBuffer` (exported from the package root)
  accumulates bytes in arrival order, keeps memory bounded by retaining only
  the tail, counts the full totals, and — with `spillToFile: true` — streams
  the complete output to a temp file. `snapshot()` returns the truncated,
  tail-biased view for `ctx.progress` and the final `ToolResult`;
  `finalize()` closes the spill file (removing it when nothing was dropped)
  and yields a `fullOutputPath` to surface when the in-context view is
  truncated.
- **Rich results.** Return `{ content, isError?, display? }`, where `display`
  carries ACP rendering metadata: `title`, `kind`, `locations`,
  `content` (rich `ToolCallContent[]`, including `{ type: "terminal",
  terminalId }` when driving an ACP client terminal), and `rawOutput`
  (e.g. `{ exitCode, signal, durationMs, fullOutputPath }`).

The built-in `bash` tool is the worked example: it streams cumulative output
via `ctx.progress`, bounds it with `OutputBuffer` (spilling to a temp file on
overflow), drives the ACP client terminal when one is bridged
(`ctx.client.createTerminal`), and otherwise spawns directly under the
capability sandbox.

```ts
import { OutputBuffer } from "@mcmaki/loom";

async execute(input, ctx) {
  const out = new OutputBuffer({ spillToFile: true });
  const child = spawn(cmd, args, { signal: ctx.abortSignal });
  child.stdout.on("data", (b) => { out.append(b); throttledProgress(ctx, out); });
  child.stderr.on("data", (b) => { out.append(b); throttledProgress(ctx, out); });
  const code = await once(child, "close");
  const snap = await out.finalize();
  return {
    content: snap.text,
    isError: code !== 0,
    display: { kind: "execute", rawOutput: { exitCode: code, fullOutputPath: snap.fullOutputPath } },
  };
}
```

---

## Layered sessions

A session in Loom is either a single layer or a stack of layers.
The `Session` interface defines the composition protocol: **`push`**
flows top-to-bottom (each layer may transform, drop, or fan-out the
event; the bottom layer is typically storage), **`pull`** flows
bottom-to-top (each layer may rewrite what the layers below
produced; the top is the prompt the harness sees), and every other
hook (`tools()`, `systemPromptSection()`, `prepareTurn()`,
`close()`) aggregates across layers.

Declare layers with `[[session.layers]]` (array-of-tables),
`[session] layers = [...]` (inline; all-strings or all-tables,
a TOML parser quirk), or a `SessionSpec[]` on
`AgentManifest.session` (SDK). A singleton `[session]` with just
`provider = "..."` is the one-layer case; when absent entirely, the
default chain `skills → compacting → in-memory` applies — bounded
growth and skill auto-loading out of the box.

**Pass-through vs storage**. _Pass-through_ layers transform
events flowing through the chain without persisting them
(`compacting`, `skills`); storage layers retain them (`in-memory`,
`file`). Boot fails with a clear error if every factory-based layer
is pass-through — every turn would see an empty history — so end
your chain with a storage layer. Session authors flag pass-through
factories with `passThrough: true`; the default is storage-class,
the safe default for third-party sessions.

A layer can also contribute tools. `Session.tools()` is **the**
single channel by which tools enter an agent beyond the manifest
itself: it returns labeled **tool groups** — `{ label, tools }`,
where `tools` is a `[tools]`-shaped table using the same closed
entry grammar, parsed by the manifest parser itself, and judged
against the effective ceiling at boot (see the
[Capabilities reference](#capabilities-reference) for the judging
rules). Entries the session implements itself use the reserved
provider `"session"`; the runtime resolves those names through the
session chain's `resolveTool(name, config, agent, capabilities)` —
no separate `[tools.X]` entry needed (this is how the notes example
bundles its `remember` verb with the session that stores it).

A group may also carry its own `providers` table — same shape as
the manifest's `[providers]`, but with **group-local** handles:
lexically scoped to that group's entries (`"builtin"` and
`"session"` reserved), substituted with their values before
resolution, and deduped globally by value so identical specs
shipped by several groups share one instance. Entries that resolve
to a group-shipped implementation need instance-name acceptance in
`[capabilities]` — see
[the consent rule](#tool-entries-select-name-and-authorize).

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
    compactor, // pre-built Session instance, used verbatim
    "notes", // resolved via [providers].notes
    "in-memory", // built-in
  ],
  // ...
};

const agent = await runAgent(manifest);
// `compactor` is the same instance the runtime is driving:
await compactor.compactNow(harness); // forced compaction
const used = compactor.tokensInContext; // peek at usage
```

Reach for this when you need a **handle** to a specific layer —
wiring `compactor.compactNow()` to a `/compact` slash command, or
reading `tokensInContext` for a context-usage UI; with the TOML
form, the runtime owns every instance. For the singleton case, pass
the instance directly: `session: someSession`. See
[`examples/sdk-agent/agent.ts`](./examples/sdk-agent/agent.ts) for
a complete working example.

---

## Capabilities reference

### The effective ceiling

The agent's **total authority surface** — the _effective ceiling_ —
is `[capabilities]` unioned with the inline `capabilities`
declarations on the manifest's own `[tools]` entries; root
declarations are **self-authorizing** (same author, same file), so
an inline request widens the ceiling rather than exceeding it.
Anything absent from the ceiling is unreachable; contributed
declarations (tool groups from skills and session layers) are
judged against the union and can never widen it. `loom audit`
prints the computed ceiling at the top of the tree (`grants` in
`--json`). Read `[capabilities]` as the **pre-authorization
surface** — authority not attached to a tool entry: **grants** for
bare entries (`bash = "builtin"` picks up its row), **acceptance
rows** for contributions that haven't arrived yet, and **ceilings**
for delegation.

**No `[capabilities]` section ≠ fail open.** Absent the section,
the conservative default ceiling applies: exactly the four
FS/shell tools (`bash`, `read_file`, `write_file`, `edit_file`)
over the working directory — no network, nothing else. Skill
activation needs no read grants (the skills layer's `read_skill`
tool handles it — see the [`skills` session](#skills)), so the
default stays this small. Wildcards are always explicit; loom
never widens a grant on its own.

Every tool declares the capability _kinds_ it needs (`requires`)
and those it may use if granted (`optional`); grants are per-tool:

```toml
[capabilities]
bash      = { commands = "*", paths = ["./"], env = ["PATH", "HOME"] }
read_file = { paths = ["./"] }
edit_file = "*"                # whole-tool unrestricted
fetch_url = "*"
```

### Tool entries select, name, and authorize

A `[tools.X]` entry never configures. It has exactly three keys:

| Key            | Meaning                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`     | Implementation reference: `"builtin"`, `"session"`, a `[providers]` handle, a source spec, or the **inline form of a configured `[providers]` entry** (`{ provider = "mcp-server", npm = "…" }`). |
| `tool`         | Underlying tool name when the instance key is a rename.                                                                                                                                           |
| `capabilities` | The **requested grant** for this instance.                                                                                                                                                        |

Construction config lives on the thing being constructed — a
`[providers]` entry, `[session.X]`, or `[harness]`; per-instance
parameters are capability kinds. The inline provider form is just
an anonymous `[providers]` entry — same parser, same resolution
path, **deduplicated by value**, so one spec means one process. An
entry omitting `capabilities` requests the full ceiling entry for
its name (`ceiling[instance] ?? ceiling[underlying]`); one carrying
it is self-authorizing — both the requested grant and a widening
of the ceiling.

Contributed entries (from session tool groups) are instead judged
against the effective ceiling, fail-soft — each group accepted
atomically or rejected with per-declaration verdicts. A contributed
entry with no `capabilities` field requests nothing and is always
granted; if its tool needs grants nothing pre-authorized, boot
fails at the ordinary `requires` check.

**Shipping an implementation needs by-name consent.** A contributed
entry that references a root-trusted implementation — `"builtin"`,
the reserved `"session"`, or a handle into the manifest's own
`[providers]` — only needs its request to fit the ceiling. An
entry that ships its **own** implementation (an inline
configured table or npm/path spec, possibly via a group-local
handle) is an authority claim the grant vocabulary can't see:
materializing a provider loads code or spawns a process before any
verdict-gated tool runs. Such an entry is accepted only when the
instance is **named** in `[capabilities]` — judged against that
instance-name entry alone, the underlying-name fallback never
widens acceptance, and a bare request is never silently granted.
Rejections print the provider spec and a paste-ready acceptance
line.

### Grant shapes

| Shape              | Meaning                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `"*"`              | Whole-tool unrestricted. Sandbox engagement opts out.                                                                        |
| `{ kind = value }` | One grant row, where `value` is `"*"`, an allowlist array (`["./src", "./test"]`), or a kind-defined object.                 |
| `[ { … }, { … } ]` | A **capability set**: each row is an independent grant; a request is authorized iff it fits entirely within some single row. |
| `{}`               | Nothing granted. Tools with non-empty `requires` fail boot.                                                                  |

### Capability sets

```toml
[capabilities]
bash = [
  { commands = "*", paths = ["./"] },
  { commands = ["gcalcli"], network = "*", paths = ["~/.gcalcli"] },
]
```

A capability set is a **union of boxes, not a bounding box** — rows never
combine to authorize a request that no single row authorizes. The
grant above does _not_ give "bash" the network: arbitrary shell
commands get a network-less sandbox over `./`; only `gcalcli` gets
the network plus its config directory.

`bash` picks a sandbox per invocation. A plain `cmd args…`
invocation of a per-command row's command — bare words and simple
quotes only; no `$`, backticks, pipes, redirects, or `FOO=bar`
prefixes — is **promoted to direct argv exec** (no shell) under
that row's sandbox. Everything else runs under the general
(`commands = "*"`) row's shell, or is refused with a teaching
error when no general row exists.

Per-command rows still reach inside that shell: whenever the
general row engages the sandbox, loom puts a **broker shim** for
each rowed command on the shell's `PATH`. Invoking the command by
name — in a pipeline, an interpreter, a script (`gcalcli … | curl
…`, `bash -c "gcalcli …"`, a Python one-liner that shells out) —
transparently runs _that command_ under _its_ row's sandbox via a
host broker, while everything around it keeps the general row's
privileges. The match is by command name as resolved through
`PATH`: invoking the binary by absolute path or under a renamed
copy dodges the shim and falls back to the general row. That
fallback is **fail-safe** — dodging the shim loses the elevated
grant, it never grants one — and the broker only ever elevates a
command a row names explicitly.

**What per-command network rows buy you — honestly.** They shrink
and itemize the exfiltration surface — `loom audit` can enumerate
exactly which binaries may touch the network and with what
filesystem view — but they do **not** eliminate it; nothing does
while one model holds both secret-reads and any network path. Treat
a capability set as a reviewable, enumerable risk list, not a proof of
impossibility.

### How a row reaches a pipeline: the command broker

This is the machinery behind "carry their own grants wherever they
run." When a capability set has a general row that engages the sandbox,
loom stands up a **broker** for the per-command rows before
launching the shell:

- A throwaway directory holds one small **shim** plus an executable
  symlink named after each rowed command (`gcalcli` → shim). That
  directory is prepended to the sandboxed shell's `PATH`, so a bare
  `gcalcli` — typed, piped, or reached from inside an interpreter —
  resolves to the shim.
- The shim doesn't run anything. It connects a unix socket back to
  the loom process, streams a request (`argv`, `cwd`, `env`) up,
  then relays stdin up and stdout / stderr / exit-status down.
- The **broker** (inside loom, outside the sandbox) looks up the
  row for `argv[0]`, runs the _real_ command in a fresh sandbox
  built from _that row's_ grant, and streams the result back.

```
  sandboxed shell:  … | gcalcli … | …
                          │  (PATH resolves gcalcli to the shim)
                          ▼
                        shim ──unix socket──▶ broker  (host, in loom)
                                                 │ re-sandbox under
                                                 │ the gcalcli row
                                                 ▼
                                            real gcalcli
                          ◀──stdout/stderr/exit─────┘
```

The command runs with its own filesystem and network view no matter
how deeply it is nested, while everything around it keeps the
general row.

**The model never sees any of this.** The bash tool's description
states each command's standing grant — _"These commands carry their
own grants wherever they run … `gcalcli` (network access;
filesystem: ~/.gcalcli)"_ — so the model treats `gcalcli` as a thing
that can reach the network and uses it normally. There is no broker
tool and no "escalate" step to learn.

**It is fail-closed, and the socket — not the shim — is the trust
boundary.** The broker:

- runs **only** commands a row names explicitly; anything else is
  refused (`commands = "*"` never brokers);
- resolves the command against the **host** `PATH`, never the
  agent's, so an agent cannot plant a fake `gcalcli` in a writable
  directory and have its code run under the row's grant — the name
  maps to the real installed binary;
- **always** re-sandboxes, or refuses when no backend is available
  (the broker itself runs unconfined, so it never hands authority to
  an unsandboxed child);
- is bypassable only _downward_: an absolute path or a renamed copy
  dodges the shim and falls back to the general row — losing the
  grant, never gaining one.

**Fidelity.** `cwd` (read at the point of invocation, so it is
correct even many processes deep), environment, stdin/stdout/stderr,
and exit status — including signal deaths, reported `128+signum` so
`pipefail` works — round-trip as if the command ran in place.
`isatty` is the one thing it cannot reproduce: the streams are
pipes, so a brokered command sees a non-tty, exactly as every other
command the bash tool runs does.

The broker is enforced on macOS `sandbox-exec` today; the Linux
`bwrap` path uses the same broker and is wired but pending
verification.

### The algebra is tool-owned

Containment ("does this grant cover that request?") and merge
("fold two grants into one") are decided by the tool itself via the
optional `containsGrant(superset, subset)` / `mergeGrants(a, b)`
hooks; loom only ever compares grants through this algebra. The
default semantics are **strict**:

- A kind absent from a grant is **not** granted — there is no
  implicit `"*"`.
- `"*"` contains everything; nothing but `"*"` contains `"*"`.
- Capability sets compare row-wise: every subset row must fit entirely
  within some single superset row.
- The default merge is the deduplicated union of the two capability sets —
  lossless, never the kind-wise bounding box.

The path-based builtins override containment so `paths` values
compare lexically (`["./src"]` is contained by `["./"]`); `bash`
does the same per row. Whatever a tool implements, the runtime
asserts the merge law — `merge(a, b)` must contain both under
`containsGrant` — and fails loudly naming the offending tool.

**Who owns rows.** Loom owns the row _form_: it's the free join —
the only lossless default merge possible without interpreting
kinds — so the default algebra and the grant grammar admit it for
every tool. Tools own row _meaning_; the one cross-tool guarantee
is that containment never mixes rows, so each row is coherent in
isolation. Tool authors pick a tier:

1. **Indifferent** — read kinds via `kindGranted`/`valueFor`
   (row-aware; first row carrying the kind wins). No row code.
2. **Refusing** — call `singleRowGrant(grant, name)` at
   construction; a multi-row grant fails boot with a teaching
   error instead of misbehaving at execute time.
3. **Embracing** — implement `containsGrant`/`mergeGrants` and
   dispatch one row per operation, as `bash` does.

Rows only reach a tool when a manifest author writes them or the
default merge folds a contribution onto it — and the latter is
exactly what `mergeGrants` overrides.

### Kinds shipped by the built-in tools

| Kind       | Used by                                                | Semantics                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths`    | `read_file`, `write_file`, `edit_file`, `find`, `bash` | `"*"` any FS; `["./"]` allowlist roots (lexical containment); absent → the tool defaults to the working directory                                                                                    |
| `commands` | `bash`                                                 | `"*"` shell mode (any command via `bash -c`); `["cat", …]` argv mode (model picks from list, direct spawn, no shell); rows of both kinds compose in a capability set; absent → boot fails (required) |
| `network`  | `bash`                                                 | `"*"` allow; `[]` or absent → deny. Per-host filtering isn't supported by the OS sandboxes.                                                                                                          |
| `env`      | `bash`                                                 | Two-tier inheritance — see below                                                                                                                                                                     |
| `manifest` | `spawn_subagent`                                       | An inline sub-agent manifest — the delegated authority itself. See the tool's section.                                                                                                               |

The Anthropic harness's server tools add their own kinds
(`max_uses`, `allowed_domains`, `blocked_domains`, `user_location`,
`max_content_tokens`, `citations`) — see `web_search` below.

### Bash env inheritance

Bash inherits environment variables in two tiers. **Tier 1 —
always inherited, never overridable** (locale and terminal
plumbing): `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `COLORTERM`,
`LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`. **Tier 2 — default-on,
replaceable** (dropped when `env` is an explicit list): `PATH`,
`PWD`, `TMPDIR`, `EDITOR`, `VISUAL`, `PAGER`.

| Grant             | Result                                   |
| ----------------- | ---------------------------------------- |
| `env` absent      | Tier 1 + Tier 2 (the convenient default) |
| `env = "*"`       | full `process.env`                       |
| `env = []`        | Tier 1 only (hermetic-but-functional)    |
| `env = ["NAME"]`  | Tier 1 + `NAME`                          |
| `env = ["AWS_*"]` | Tier 1 + prefix match on `AWS_`          |

### Subagent ceiling

`[capabilities]` is a transitive ceiling across the sub-agent tree:
every sub-agent's grant must be contained by the parent's grant for
the same key, under the strict algebra above. `loom audit` walks
the whole tree statically and reports violations before they hit
at runtime — and the same containment is **enforced at spawn
time**: spawning a sub-agent whose effective ceiling exceeds the
parent's throws a `CapabilityError` naming the offending keys, so
the tool call fails and the sub-agent never boots. Mind the
error's guidance: a sub-manifest with no `[capabilities]` section
gets the **default** ceiling, not an empty one — give it an empty
`[capabilities]` table (`capabilities: {}` from the SDK) to
request none.

---

## Writing skills

A loom skill is a standard [Agent Skills](https://agentskills.io)
folder — a directory with a `SKILL.md` whose frontmatter has `name`
and `description`, instructions in the body, and optional
`scripts/`, `references/`, and `assets/`. Any spec-compliant skill
works in loom with no loom-specific metadata at all: it compiles to
the authority-free group `{ read_skill: {} }`. Activation and
bundled-file reads go through the skills layer's `read_skill` tool,
so a pure-instructions skill requests **no authority whatsoever**
— no read grants, no paths. On activation the model sees your
SKILL.md body wrapped in `<skill name="…" directory="…">` tags, a
note that relative paths resolve against the skill directory, and
a listing of bundled resources it can fetch one at a time — write
the body with that frame in mind.

Loom-specific metadata starts when a skill needs _authority_ — a
command, network access, a tool of its own. Declarations are for
authority only; never declare `read_file` over your own directory
just to make bundled files readable — `read_skill` already covers
that. Declare authority in the frontmatter `metadata` table as
TOML carried in YAML block scalars:

```markdown
---
name: dns-lookup
description: Look up DNS records with dig. Use when the user asks
  what a domain resolves to.
metadata:
  loom.tools: |
    bash = { capabilities = { commands = ["dig"], network = "*" } }
---

# DNS lookup

Use the `bash` tool to invoke `dig`. Its network grant is bound to
the `dig` command, so it holds even in a pipeline…
```

The keys:

| Key              | Contents                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loom.tools`     | A `[tools]` table body — the exact grammar of a manifest's `[tools]` section, parsed by the same code. Provider-less entries contribute grant rows to a tool the host already has (`bash` above); entries with `provider`/`tool` declare new instances (e.g. `jq = { provider = "builtin", tool = "bash", capabilities = { commands = ["jq"] } }`). |
| `loom.providers` | A `[providers]` table body, for skills that ship software (an MCP server in the skill folder, an npm package). Handles are local to the skill; sources dedup globally by value.                                                                                                                                                                     |

`${SKILL_DIR}` substitutes textually — before TOML parsing — to the
skill's absolute directory, so authority declarations can reference
bundled files (`args = ["${SKILL_DIR}/server.mjs"]` for a shipped
server, `paths = ["${SKILL_DIR}"]` in a bash row that must execute
bundled scripts) without knowing where the skill is installed.

**Declare the minimum.** Your declaration is a _request_, judged
against the host's `[capabilities]` ceiling — atomically: one
over-broad entry rejects the whole skill, fail-soft, and the skill
vanishes from the model's catalog. The remediation line users see
is generated _from your declaration_, so a precise request
(`commands = ["dig"]`, not `commands = "*"`) is both your best
chance of fitting an existing ceiling and the consent prompt your
users will be asked to paste. Skills that ship their own
implementation (`loom.providers`, or a `provider` source in an
entry) additionally require the host to **name the instance** in
`[capabilities]` — fitting the ceiling is never enough to run
contributed code. See
[the consent rule](#tool-entries-select-name-and-authorize).

**Write instructions for the sandbox you asked for.** If you
declared a per-command row, name the command in the body ("use
`dig` to look up records"): the broker binds your row's grant to
that command name, so it applies whether the model invokes it
plainly or inside a pipeline. The grant follows the command, not
the shape of the line — but only for the command you named, so be
specific about which binary does the privileged work.

**Enhancing a skill you don't author:** drop a `loom.toml` sidecar
(`[tools]` + optional `[providers]`) next to someone else's
`SKILL.md` — it wins over frontmatter entirely.

**Portability:** `loom.*` metadata keys are spec-legal string
values; other Agent Skills clients ignore them. Use the spec's
`compatibility` field for human-facing requirements ("requires dig
on PATH"), and keep the body client-agnostic.

Validate with `loom audit <agent.toml>` against a manifest that
mounts your skill: ACTIVE/INACTIVE per declaration, with reasons.
`examples/skills-agent/` has one skill per authoring tier — from
zero-metadata to MCP-server-shipping — and the
[`skills` session docs](#skills) cover the host-side mechanics.

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

| Config key        | Default                     | Notes                                          |
| ----------------- | --------------------------- | ---------------------------------------------- |
| `model`           | `claude-sonnet-4-5-latest`  | Any Anthropic model id.                        |
| `apiBase`         | `https://api.anthropic.com` | Override for proxies / self-hosted.            |
| `maxTokens`       | `4096`                      | Per-response output cap.                       |
| `maxTurnRequests` | `16`                        | Tool-call round-trip safety limit per turn.    |
| `stream`          | `true`                      | When false, the response arrives as one block. |

- **Secrets:** `ANTHROPIC_API_KEY` (required).
- **ACP capabilities:** advertises `promptCapabilities.image` and
  `promptCapabilities.embeddedContext` at `initialize` time, so
  ACP clients know they can attach images and embedded resources.
- **SDK class:** `AnthropicHarness` (also implements `withModel(id)`
  and `smallModel()` for use under `small-model-of-parent`).

#### `openai`

OpenAI via the Responses API (the streaming successor to Chat
Completions). Same tool-dispatch shape as Anthropic.

| Config key        | Default                     | Notes                                                |
| ----------------- | --------------------------- | ---------------------------------------------------- |
| `model`           | `gpt-5.1`                   | Any OpenAI Responses-API-compatible model.           |
| `apiBase`         | `https://api.openai.com/v1` | Override for proxies / Azure / self-hosted.          |
| `maxOutputTokens` | unset                       | Per-response output cap; omit to use server default. |
| `maxTurnRequests` | `16`                        | Tool-call round-trip safety limit per turn.          |
| `stream`          | `true`                      | When false, the response arrives as one block.       |

- **Secrets:** `OPENAI_API_KEY` (required).
- **ACP capabilities:** same as `anthropic` (image + embeddedContext).
- **SDK class:** `OpenAIHarness` (also implements `withModel(id)`
  and `smallModel()`).

#### `small-model-of-parent`

**Sub-agent only.** Clones the parent agent's harness, swapping in
a cheaper / smaller model. Lets the parent reach into the runtime
for a routing decision or a one-off summary without burning the
full frontier model.

| Config key | Default                 | Notes                                                                    |
| ---------- | ----------------------- | ------------------------------------------------------------------------ |
| `model`    | parent's `smallModel()` | Explicit id wins; otherwise the parent harness's recommendation is used. |

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
default chain `skills → compacting → in-memory`; `skills` silently
no-ops when `~/.skills` is missing.

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

| Config key | Default                   | Notes                                                                                                                |
| ---------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `path`     | `<storage>/session.jsonl` | Absolute or relative to manifest dir. Defaults to `session.jsonl` in the agent's per-agent storage dir when omitted. |

Use as a drop-in replacement for `in-memory` when you want the
conversation to survive process exit.

- **SDK class:** `FileSession`.

#### `compacting`

A pull-side transform that summarises older events past a threshold.
Designed to sit **above** a storage layer in a chain. On push it's
a passthrough (events flow down to be stored) but it swallows
`usage_update` events so token usage stays as in-memory metadata
instead of cluttering the durable log.

| Config key                            | Default                         | Notes                                                                                                                                                                          |
| ------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `threshold`                           | `40`                            | Event-count threshold that trips compaction. Auto-raised to `keep + 4` if set at or below `keep + 2`, so a too-small value won't be honored verbatim.                          |
| `tokenThreshold`                      | unset (SDK only)                | Token-count threshold (uses latest `usage_update.used`); takes priority over `threshold` when usage data is available.                                                         |
| `token_fraction` / `tokenFraction`    | unset                           | Trip compaction when used tokens reach this fraction of the last context size (e.g. `0.75`). Uses `usage_update` data; takes priority over the count threshold when available. |
| `keep`                                | `10`                            | Most recent events that survive verbatim.                                                                                                                                      |
| `persist` (TOML) / `persistDir` (SDK) | off                             | Persist compaction state to `<storage>/compacting/state.json` so summaries survive process restarts. `persist = true` uses the per-agent storage dir.                          |
| `compactor`                           | `heuristicCompactor` (SDK only) | Replace with `modelCompactor()` for model-driven summarisation.                                                                                                                |
| `onCompact`                           | none (SDK only)                 | Diagnostic callback fired after each successful compaction.                                                                                                                    |

Exports `compactingMemorySession()` and `compactingFileSession()`
as SDK helpers for the common chains. Hold a reference to the
`CompactingSession` instance (via the heterogeneous-array shape
above) to drive `compactNow()` imperatively from a slash command.

- **SDK class:** `CompactingSession`.
- **Pairs well with:** `modelCompactor({ instruction, systemPrompt, fallback })`.

#### `skills`

Discovers [Agent Skills](https://agentskills.io) folders (directories
with a `SKILL.md` YAML-frontmatter file) and contributes three
things:

- **A catalog** — a system-prompt section listing each usable
  skill's name, path, and description, telling the model to
  activate skills with `read_skill`.
- **The `read_skill` tool** — contributed through the same channel
  as everything else: the session's first tool group
  (`"skills session"`) declares `read_skill = { provider =
"session" }`, resolved by the session itself.
- **Tool groups** — each skill compiles to a labeled
  `[tools]`-shaped table declaring the tools and grants it needs,
  contributed through `Session.tools()`.

**`read_skill`.** Schema `{ skill, path? }`. Called with just
`skill`, it activates: the response wraps the SKILL.md body in
`<skill name="…" directory="…">…</skill>` tags, notes that
relative paths in the instructions resolve against the skill
directory, and appends a listing of bundled resources (capped at
50 entries) — listed, never eagerly loaded. Pass `path` to read
one bundled file. Trimmed skills are invisible through it: a
rejected or post-boot-disqualified skill can't be activated or
read. Because `read_skill` runs as session code — no grant check,
no OS sandbox — it self-polices containment, realpathing both
sides so symlinks can't escape the skill directory.

| Config key       | Default     | Notes                                                                                                                      |
| ---------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `root` / `roots` | `~/.skills` | One root or many. Relative paths resolve against manifest dir; `~` expands to OS home; missing roots are silently skipped. |

(`default_tools` no longer exists — skills declare the tools they
need themselves, and boot fails with a pointer if you set it.)

**The skill→tools compiler.** Precedence, per skill directory:

1. A `loom.toml` sidecar next to `SKILL.md` wins entirely — its
   `[tools]` table (plus an optional `[providers]` table) is the
   group. This is the "enhance a skill you didn't author" path.
2. Else the frontmatter `metadata` keys `loom.tools` /
   `loom.providers`: TOML snippets carried as YAML block scalars.
3. Else the **authority-free default**: the group `{ read_skill: {} }`
   — activation and bundled reads go through `read_skill`, so the
   skill requests no authority at all.

`${SKILL_DIR}` substitutes textually (before the TOML is parsed) to
the skill's absolute directory. Declarations are parsed by the
manifest parser itself, so authoring errors and capability
semantics are identical across manifests, the SDK, and skills —
see the [Capabilities reference](#capabilities-reference) for how
contributed entries are judged.

**Skills can ship software.** A skill's `[providers]` declarations
(frontmatter `loom.providers` or the sidecar table) are the
group-local handles described under
[Layered sessions](#layered-sessions). Because the skill carries
its own implementation, fitting the ceiling isn't enough: the host
manifest must **name the instance** in `[capabilities]`, and that
line is the consent to run the skill's code (see
[the consent rule](#tool-entries-select-name-and-authorize)).
`examples/skills-agent/skills/echo-notes/` bundles an MCP server
this way, accepted by the manifest's `echo_note = "*"` entry.

**Verdicts.** Groups are judged at boot — fail-soft, atomic per
group, with paste-ready `[capabilities]` TOML remediation per
rejected declaration. Under run, rejected skills are **trimmed
from the catalog** — the model never sees them; under audit,
they're listed as INACTIVE with the reason.

**Post-boot is subtractive only.** Roots rescan each turn, but a
skill that appears mid-session can at most reference already-granted
authority: if its declarations exceed the ceiling it's trimmed, and
if it declares new tool instances it stays inactive until a restart
binds them.

**Worked example.** A calendar skill that needs `gcalcli`:

```markdown
---
name: calendar
description: Read and edit Google Calendar with gcalcli.
metadata:
  loom.tools: |
    bash = { capabilities = { commands = ["gcalcli"], network = "*", paths = ["~/.gcalcli"] } }
---

Run `gcalcli agenda` to …
```

The skill _declares_; the user _accepts_ by covering the declaration
in the ceiling:

```toml
[capabilities]
bash = [
  { commands = "*", paths = ["./"] },
  { commands = ["gcalcli"], network = "*", paths = ["~/.gcalcli"] },
]
```

At boot the declaration passes containment (the `gcalcli` row
covers the bash request row-for-row) and the skill shows in the
catalog. Drop the second `bash` row and the skill is trimmed
instead. Note what's _not_ here: no read grant of any kind —
activation and bundled reads ride `read_skill`. Mounting a skills
root in `[session]` is the consent to a skill's _instructions_;
any _authority_ it wants still has to clear this ceiling.

For a runnable tour of all five tiers — authority-free
(`read_skill` only), frontmatter bash row, sidecar-renamed
instance, skill-shipped MCP server, deliberate rejection — see
[`examples/skills-agent/`](./examples/skills-agent/). Skills with
malformed frontmatter are skipped quietly so boot stays resilient.

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
be renamed (`tool = "original_name"`), narrowed (capability grant
binds args), and constrained by enum (array grant). See the full
section below for the integration tour.

| Config key         | Default                 | Notes                                                                                                                                                                                           |
| ------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command` + `args` | required (or `npm`)     | Generic stdio launcher.                                                                                                                                                                         |
| `npm`              | required (or `command`) | Shorthand for npm-distributed servers. Equivalent to `command = "npx"` + `args = ["-y", "<pkg>"]`.                                                                                              |
| `env`              | none                    | Static env vars passed to the spawned process.                                                                                                                                                  |
| `secrets`          | `{}`                    | Map of `LOOM_SECRET_NAME = "ENV_VAR_NAME"`. Each LHS is resolved through Loom's secret store and injected into the child's env under the RHS name. Per-instance, marked as required at Phase 1. |

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

| Input field  | Type              | Notes                                              |
| ------------ | ----------------- | -------------------------------------------------- |
| `command`    | string (required) | The command to run.                                |
| `cwd`        | string            | Working directory; must be inside an allowed path. |
| `timeout_ms` | number            | Default 30000.                                     |

- **Capability kinds:** requires `commands`; optional `paths`, `network`, `env`.
  - `commands = "*"` → **shell mode**: input is a free-form `command` string,
    dispatched via `/bin/bash -c "…"`.
  - `commands = ["pwd", "cat"]` → **argv mode**: the input schema enumerates
    the allowed commands and exposes an `args` array; dispatch is direct
    `spawn(cmd, args, …)` with no shell. Useful for scoped sub-agents that
    should only run a handful of programs.
  - A **capability set** mixes both — see [Capability sets](#capability-sets) for the
    dispatch and attribution rules, and
    [the command broker](#how-a-row-reaches-a-pipeline-the-command-broker)
    for how a per-command grant follows its command into pipelines
    and interpreters. The tool description enumerates the rows for
    the model.
- **Sandbox profile** is derived from the picked row's grant — a structured
  grant engages the sandbox; `"*"` opts out (no confinement).

#### `read_file`

Read a file's contents as UTF-8.

| Input field | Type              | Notes                                                                 |
| ----------- | ----------------- | --------------------------------------------------------------------- |
| `path`      | string (required) | Resolved against cwd unless absolute. Must be inside an allowed path. |

- **Capability kinds:** optional `paths` (defaults to `["./"]` when
  `[tools]` is omitted entirely; otherwise an explicit grant is
  required).

#### `write_file`

Write a UTF-8 file in full. Use this to **create new files** or
**wholesale-replace** existing ones. For targeted changes to an
existing file, prefer `edit_file` — it's much more efficient (no
need to repeat the unchanged bulk of the file) and produces a diff
in the wire `tool_call_update` for IDE-client rendering.

| Input field   | Type              | Notes                                                                                                                               |
| ------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `path`        | string (required) | Resolved against cwd unless absolute.                                                                                               |
| `content`     | string (required) | Full file contents.                                                                                                                 |
| `append`      | bool              | Append instead of overwriting. Default false.                                                                                       |
| `create_dirs` | bool              | Create missing parent directories first. Default false — without it, writing to a not-yet-existing nested path fails with `ENOENT`. |

- **Capability kinds:** optional `paths`.
- **ACP routing:** when the client advertises `fs.writeTextFile`,
  the write goes through the editor (surfaces as an in-editor change
  with diff + approval UI). `append` and `create_dirs` fall back to
  local `fs` since ACP's `fs/writeTextFile` is full-file-replacement
  only with no mkdir affordance.

#### `edit_file`

Modify an existing UTF-8 file by exact text replacement. The model
passes one or more `{ old_text, new_text }` pairs; each `old_text`
must match a **unique** substring of the file's current content.
All replacements apply against the _original_ file, not
incrementally — the model doesn't have to reason about how earlier
edits shifted positions. Overlapping or nested matches are
rejected. The wire `tool_call_update` carries an ACP `Diff` content
block so IDE clients render an inline before/after view.

| Input field | Type                                             | Notes                                             |
| ----------- | ------------------------------------------------ | ------------------------------------------------- |
| `path`      | string (required)                                | Resolved against cwd unless absolute. Must exist. |
| `edits`     | `{ old_text, new_text }[]` (required, non-empty) | Each `old_text` unique in the file.               |

- **Capability kinds:** optional `paths`.
- **No file creation.** `edit_file` refuses to create new files; use
  `write_file` (or `bash` with a heredoc) when the file doesn't yet
  exist. Keeps the model's mental model simple — a missing file is a
  clear error rather than a silent new-file creation.

#### `find`

Glob-walk a directory tree. Opt-in built-in — list `find = "builtin"`
in `[tools]` to pull it in (`bash` covers most of what you'd reach
for `find` for, so the default set leaves it out).

| Input field | Type              | Notes                                                                                  |
| ----------- | ----------------- | -------------------------------------------------------------------------------------- |
| `pattern`   | string (required) | Glob (`**/*.ts`, `src/*.md`, etc.). `*` matches non-`/` chars; `**` matches any depth. |
| `root`      | string            | Root to walk. Default `.`.                                                             |
| `limit`     | number            | Max results. Default 200.                                                              |

- **Capability kinds:** optional `paths`.
- The wire `tool_call_update` is annotated with `kind: "search"`
  and a per-invocation title (`find <pattern>`) so IDE clients
  render the right icon.

#### `spawn_subagent`

Run a sub-agent for one turn and return its final assistant
message. Two modes:

1. **Self-copy** (default). The sub-agent is a structural copy of
   the owning agent's manifest, with `spawn_subagent` itself
   stripped from `[tools]` and `[capabilities]` so the recursion
   bottoms out one level deep. Each spawned copy shares storage with
   the parent by default (same `name` / `storageId`). This is the
   simplest way to give an agent a "think harder / fan out" verb —
   the clone runs with the same harness, session config, and tools.
   A self-copy can never exceed the parent's authority.
2. **Granted sub-manifest** (explicit). The sub-manifest lives in
   the _grant_ — `spawn_subagent = { manifest = {...} }` — not in
   config: it IS the capability declaration, stating exactly the
   authority being delegated. Spelled as nested TOML tables:

   ```toml
   [capabilities.spawn_subagent.manifest]
   name = "researcher"

   [capabilities.spawn_subagent.manifest.harness]
   provider = "anthropic"
   model = "claude-haiku-4-5"

   [capabilities.spawn_subagent.manifest.tools]
   read_file = "builtin"

   [capabilities.spawn_subagent.manifest.capabilities]
   read_file = { paths = ["./"] }
   ```

Either way, the resolved sub-manifest is recorded in
`tool.dependencies.subagents` so `loom audit` walks it (audit cycle
detection handles trivial loops; self-copy avoids them by stripping
`spawn_subagent` from the clone), and the
[subagent ceiling](#subagent-ceiling) check applies — trivially
satisfied for self-copies, and enforced **at spawn time**: a
sub-manifest whose effective ceiling exceeds the parent's fails
the tool call with a `CapabilityError` before the sub-agent boots,
not just an audit finding.

| Input field | Type              | Notes                                      |
| ----------- | ----------------- | ------------------------------------------ |
| `prompt`    | string (required) | The user message to send to the sub-agent. |

- **Capability kinds:** optional `manifest`. Omit it (e.g.
  `spawn_subagent = "*"`) for the self-copy default; grant
  `{ manifest = {...} }` for an explicit sub-manifest. There is no
  `[tools.spawn_subagent]` config
  ([tool entries never configure](#tool-entries-select-name-and-authorize)).
- The ceiling check bounds what the sub-agent's tools can do,
  regardless of what else `spawn_subagent` is granted.

Example (self-copy):

```toml
[tools]
spawn_subagent = "builtin"
bash           = "builtin"

[capabilities]
spawn_subagent = "*"
bash           = { commands = "*", paths = ["./"] }
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

| `provider =`  | Path                                          | Bill                           | Works with             |
| ------------- | --------------------------------------------- | ------------------------------ | ---------------------- |
| `"builtin"`   | Brave LLM Context API                         | Brave (`BRAVE_SEARCH_API_KEY`) | any harness            |
| `"anthropic"` | Anthropic server tool (`web_search_20250305`) | Anthropic API                  | Anthropic harness only |

The harness-exposed flavour is the lower-friction option when
you're already on Claude (one less API key, model gets
`encrypted_content` back for citation re-grounding on subsequent
turns). Use `loom providers list` to see which harness-exposed
server tools your installed harnesses publish; opt in via
`provider = "<harness-name>"` in `[tools]`. See
`examples/full-agent/agent.toml` for both flavours side-by-side.

The harness-exposed variants take no tool config at all — every
knob is a **capability kind**, declared in `[capabilities]` so the
manifest carries the whole authority picture: `max_uses`,
`allowed_domains`, `blocked_domains`, `user_location` for
`web_search`; `max_uses`, `max_content_tokens`, `allowed_domains`,
`blocked_domains`, `citations` for `web_fetch`. Loom translates the
grant onto the wire (`web_search_20250305` / `web_fetch_20250910`):

```toml
[tools]
web_search = "anthropic"
web_fetch  = "anthropic"

[capabilities]
web_search = { max_uses = 3, allowed_domains = ["docs.python.org"] }
web_fetch  = { max_uses = 2, max_content_tokens = 8000 }
```

The rest of this section documents the **Brave builtin**.

Searches the web via the [Brave LLM Context API](https://api-dashboard.search.brave.com/documentation/services/llm-context).
Returns pre-extracted, snippet-formatted results designed for LLM
grounding — no scraping, no token-budget surprises. Rendered as
markdown the model can consume directly (one section per result,
plus dedicated POI/Places sections when local recall is on).

| Input field | Type              | Notes                                                                                                          |
| ----------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `query`     | string (required) | Max 400 chars, ~50 words. Natural language; the API ranks for grounding, not keyword match.                    |
| `freshness` | string            | `pd` (24h), `pw` (7d), `pm` (31d), `py` (365d), or `YYYY-MM-DDtoYYYY-MM-DD`. Overrides the configured default. |
| `count`     | integer (1-50)    | How many results to consider. Overrides the configured default.                                                |

- **Secrets:** requires `BRAVE_SEARCH_API_KEY` (the secret name is
  overridable via the `secret_name` constructor option).
- **No capability kinds.** The tool only ever talks to one host
  (`api.search.brave.com`), so there's no useful manifest-grant
  surface.
- **Defaults:** from a manifest (`web_search = "builtin"`), only `q`
  is sent and Brave's server-side defaults apply (`count=20`,
  `maximum_number_of_tokens=8192`, `context_threshold_mode=balanced`,
  `country=us`, `search_lang=en`, no freshness filter). Tool entries
  carry no config, so the tunables below are **SDK-only** —
  construct the instance yourself (`new WebSearchTool({...})`) and
  supply it via a Tools provider.

| Constructor option     | Maps to Brave param                  | Range                                                             |
| ---------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| `count`                | `count`                              | 1-50                                                              |
| `freshness`            | `freshness`                          | `pd` / `pw` / `pm` / `py` / `YYYY-MM-DDtoYYYY-MM-DD`              |
| `country`              | `country`                            | 2-char code                                                       |
| `search_lang`          | `search_lang`                        | 2+ char code                                                      |
| `max_urls`             | `maximum_number_of_urls`             | 1-50                                                              |
| `max_tokens`           | `maximum_number_of_tokens`           | 1024-32768                                                        |
| `max_snippets`         | `maximum_number_of_snippets`         | 1-100                                                             |
| `max_tokens_per_url`   | `maximum_number_of_tokens_per_url`   | 512-8192                                                          |
| `max_snippets_per_url` | `maximum_number_of_snippets_per_url` | 1-100                                                             |
| `threshold_mode`       | `context_threshold_mode`             | `strict` / `balanced` / `lenient` / `disabled`                    |
| `enable_local`         | `enable_local`                       | bool                                                              |
| `goggles`              | `goggles`                            | URL or inline definition                                          |
| `endpoint`             | —                                    | Override the API endpoint (useful for tests).                     |
| `secret_name`          | —                                    | Secret to read the API key from (default `BRAVE_SEARCH_API_KEY`). |

Example:

```toml
[tools]
web_search = "builtin"
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

Chained in order; the first store with a hit wins. Resolution is
dotenv-style — the most _local_, explicit secret wins and we work outward
to progressively more global sources, so a `.loom-secrets` checked into an
agent's own directory overrides an ambient env var (which is often exported
globally for some unrelated tool):

1. **Caller-supplied store** — `runAgent(manifest, { secrets })`.
2. **Per-manifest file** — `.loom-secrets` next to the manifest (most local).
3. **Per-cwd file** — `.loom-secrets` in the working directory.
4. **Environment variables** — `process.env[NAME]` (also tries
   `LOOM_<NAME>` and the uppercased `-`/`.`→`_` forms).
5. **OS keychain** — macOS Keychain (service `loom`).
6. **XDG file** — `$XDG_CONFIG_HOME/loom/secrets.toml` (the global fallback).

`.loom-secrets` files are `KEY=value` lines (or a JSON object); the XDG file
is flat TOML (`KEY = "value"`). The SDK exports each layer
(`EnvSecretsStore`, `FileSecretsStore`, `XDGSecretsStore`,
`KeychainSecretsStore`, `StaticSecretsStore`, `ChainedSecretsStore`) so you
can compose your own pipeline.

### Per-agent storage

Every agent gets one directory Loom guarantees exists, surfaced to
every plugin via `FactoryContext.storage`. Plugins decide what to
put there — cached tool lists, journals, notes files, PID files —
with no key-value abstraction layered on top. Layout:

| Platform | Path                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| macOS    | `~/Library/Application Support/Loom/agents/<id>/`                                  |
| Linux    | `$XDG_DATA_HOME/loom/agents/<id>/` (`~/.local/share/loom/agents/<id>/` by default) |
| Windows  | `%APPDATA%/Loom/agents/<id>/`                                                      |

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

One `[providers]` handle = **one** MCP server process: every
`[tools.X]` entry pointing at the handle dispatches against the
same `Tools` instance, with `resolveTool` routing each call. As
everywhere, a tool entry only
[selects, names, and authorizes](#tool-entries-select-name-and-authorize)
— all server construction config lives on the `[providers]` entry,
and an inline `provider = { provider = "mcp-server", npm = "…" }`
table dedups by value to the same server process.

**Capability-based partial application.** The big win: each
`[capabilities]` per-arg grant doubles as a pre-binding. A literal
binding drops the arg from the model-visible schema and merges it
at execute time:

```toml
[tools.read_one_doc]
provider = "fs_mcp"
tool = "read_text_file"          # underlying MCP tool name

[capabilities]
read_one_doc = { path = "/path/to/welcome.md" }
```

The model sees `read_one_doc` as a **zero-argument** tool; Loom
supplies `path` transparently on every call. Same MCP tool can be
exposed under multiple model-facing names with different bindings
(`tool` rename + per-tool grant). Array grants narrow an arg to
an enum (`status = ["online", "away"]` → model can pick those
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
            inputSchema: {
              type: "object",
              required: ["url"],
              properties: { url: { type: "string" } },
            },
            requires: ["network"],
            capabilities,
            async execute(input) {
              /* … */
            },
          };
        },
      };
    },
  });
}
```

Then in the manifest — construction config (like `url_prefix`)
goes on the `[providers]` entry, never on the tool entry:

```toml
[providers]
fetch = { provider = "@my-org/loom-fetch", url_prefix = "https://api.example.com/" }

[tools]
fetch_url = { provider = "fetch" }

[capabilities]
fetch_url = { network = "*" }
```

Discovery walks `<manifest-dir>/node_modules` → `npm root -g` →
`~/.loom/providers`. `loom providers list` enumerates everything
visible.

A session can also bundle the tools it implements via its
`tools()` hook — labeled tool groups with the reserved provider
`"session"` (e.g. `remember = { provider = "session" }`), resolved
through the session chain's `resolveTool` (this method, then
native built-ins, then SDK-supplied Tools) and judged against the
effective ceiling like any other contribution — see
[Layered sessions](#layered-sessions). This is how the notes
example bundles its `remember` verb with the session that owns the
state.

---

## CLI reference

| Command                                                                             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loom run <agent.toml>`                                                             | Interactive REPL with streaming markdown, slash commands (`/help`, `/audit`, `/tools`, `/events`), and history replay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `loom prompt <agent.toml> [text] [--format <text\|trace\|jsonl>] [--emit-preamble]` | One-shot prompt (`text` or stdin). Exits after the turn with a Unix-style code (`0` clean, `130` cancelled, `1` otherwise). `--format`: `text` (default) prints only the final agent message to stdout, pipe-friendly; `trace` prints a coalesced labelled view with tool calls + stop reason; `jsonl` emits one raw `SessionUpdate` per line. `--emit-preamble` (jsonl only) prepends one `{ "preamble": { systemPrompt, events, tools } }` line capturing exactly what the model is about to see — useful for per-turn audit logging.                                                                                                                                                                                                                            |
| `loom audit <agent.toml> [--json]`                                                  | Static capability tree: the computed effective ceiling (`grants` in `--json` — the one place to see the agent's total authority) plus a `contributed tools:` section with per-group verdicts (which skill/session declarations were accepted or rejected against the ceiling, with paste-ready remediation; `toolGroups` in `--json`; the failure-path `health` report counts them as `rejectedToolGroups`). No model calls. Exits non-zero (with the partial tree printed) when the manifest isn't fully resolvable — unresolved sources, provider init failures, unresolved `[tools]` entries, missing required capabilities, sub-agent capability-ceiling violations (checked with strict containment), rejected tool groups, or `tool.audit()` error findings. |
| `loom acp serve <agent.toml>`                                                       | Speak [ACP][acp] over stdio. Pairs with any ACP-aware client.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `loom install [agent.toml]`                                                         | Materialise the manifest's npm/path sources into `.loom/node_modules/`, plus those a skill contributes via `loom.providers` (accepted groups only). `lock.toml` records the full set; `--frozen` (CI) fails if the manifest or any contributed source has drifted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `loom mcp inspect <provider-spec> [--manifest <agent.toml>] [--json]`               | Spawn an MCP server, dump its tools as paste-and-prune TOML (or JSON). Provider spec is an npm name, a path, or a `[providers]` handle from `--manifest`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `loom providers list`                                                               | List Loom provider packages discoverable from cwd.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `loom providers info <name>`                                                        | Show resolved metadata for a provider package.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `loom --version` / `-v` / `loom version`                                            | Print the installed Loom version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

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

Run the simplest example, or the notes-provider agent:

```sh
ANTHROPIC_API_KEY=... node dist/cli/main.js run examples/minimal-agent/agent.toml
# the notes-taking agent (build the provider first: cd examples/notes-provider && npm run build):
ANTHROPIC_API_KEY=... node dist/cli/main.js run examples/full-agent/agent.toml
# or the same agent via the SDK:
ANTHROPIC_API_KEY=... npx tsx examples/sdk-agent/agent.ts "your prompt here"
```

---

## License

MIT.
