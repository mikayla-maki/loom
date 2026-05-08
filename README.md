# Loom

> A manifest-driven agent meta-harness.

Loom is a declarative runtime for composing LLM agents. The user writes
an `agent.toml` (or constructs an `AgentManifest` in JS); loom parses it,
resolves secrets, instantiates a harness + session + a chain of
providers, and runs turns.

The central abstraction is the **provider chain**: each tool reference
in the manifest is a `(name, config)` pair, and loom asks each
provider in turn whether it claims the name. The native provider
claims the builtins (`bash`, `read_file`, etc.); extension providers
claim domain-specific tools (S3, Discord, MCP). Capabilities are
tool-defined; sandboxing is each tool's own responsibility (or its
provider's, when the tool needs real isolation).

Loom does NOT model skills. "Skills" — the bundled instruction +
tool-requirement + sub-agent format Anthropic's docs describe — are
a client-level concept that compiles down to Loom primitives (tools
and sub-agents). A future `loom-skills` library will adapt the
Anthropic SKILL.md format and ship as a session-factory extension;
Loom proper stays focused on the runtime.

## Status

- **Single `AgentManifest` type** — parsed from `agent.toml` or
  constructed in-memory.
- **Tools are JS objects.** Each builtin lives in
  `src/runtime/builtins/`. There's no on-disk tool format; extensions
  ship tools as code in npm packages.
- **Sub-agents** are first-class: `Agent.spawnSubagent`,
  `dependencies.subagents`, audit recursion, parent-derived providers.
- **Per-tool capability declarations** — each tool advertises its own
  capability shape (e.g. `read_file` uses `{ paths: [...] }`). Loom
  doesn't interpret the shape; tools self-police at execute time.
- **Optional `[capabilities]` ceiling** — a per-tool upper bound on the
  same shape. When present, each tool's declared caps must fit inside
  the matching entry, using the tool's own `capabilitiesContain` (or a
  structural deep-subset default).
- **Session extensions:** `file` (JSONL append log), `memory`
  (in-process, the default if `[session]` is absent), `compacting`,
  `fork-of-parent`.
- **Harness extensions:** `test` (deterministic, scripted), `anthropic`
  (Messages API), `openai` (Chat Completions),
  `small-model-of-parent`.
- **Builtin tools:** `bash`, `echo`, `read_file`, `write_file`, `find`,
  `spawn_subagent` (opt-in).
- **CLI:** `loom run`, `loom prompt`, `loom audit`, `loom acp serve`,
  `loom install`, `loom list`, `loom extensions`.
- **`LocalRegistry`** at `~/.loom/{tools,agents}/` for bare-name
  resolution.
- **ACP wire protocol** (server + client + `connectAcpUrl` for `acp://`
  and `acp+unix://` URLs).

### Architecture

Loom owns: manifest parsing, secrets, system-prompt assembly,
`[capabilities]` validation, and the turn loop. Providers own:
building Tool objects from `(name, config)` references, and any state
those tools need.

The trust model is the install boundary. Tools and extension providers
are code the user installed (the loom package itself for builtins; an
npm dep for everything else). Loom doesn't sandbox tools at runtime;
tools that need real isolation own their sandbox setup (e.g. a future
`bash`-with-container variant). Loom is a manifest-driven runtime, not
a sandbox.

What is intentionally not yet implemented: OS-level sandbox
enforcement, the `loom-skills` library, and tool / agent distribution
beyond the per-project `[extensions]` mechanism.

## Install / develop

```sh
npm install
npm run build
npm test           # full test suite
node dist/cli/main.js help
```

## The minimal agent

The smallest viable agent is just a name and a harness:

```ts
import { runAgent } from "loom";

const agent = await runAgent({
  agent: { name: "demo" },
  harness: { provider: "anthropic", model: "claude-3-5-sonnet-latest" },
});
await agent.prompt("hello");
await agent.close();
```

Defaults applied:

- `session` → `{ provider: "memory" }` (in-process log; events lost on close)
- `capabilities` (top-level ceiling) → absent (no boot-time check; each
  tool's declared caps stand)
- `tools` → the default builtin set (`bash`, `read_file`, `write_file`,
  `find`) auto-loads when the field is absent, configured for the
  project root. Declare an explicit `tools` table (even empty) to opt out.

Tighten any of those when you want to:

```ts
await runAgent({
  name: "lockdown",
  tools: {},                                 // no top-level tools
  harness: { provider: "anthropic", model: "claude-3-5-sonnet-latest" },
  session: { provider: "file", path: "./session.jsonl" },
});
```

## Top-level `[tools]`

```toml
[agent]
name = "locked-down"
system_prompt = "..."

[harness]
provider = "anthropic"
model = "claude-3-5-sonnet-latest"

[tools]
# Each entry is `name = config`. Loom routes (name, config) through the
# provider chain; the first non-null result wins.
bash = {}
read_file = { paths = ["./src", "./test"] }
# Tools added by an [extensions].<pkg> entry are claimed by their
# extension's provider and configured the same way:
# "discord.send" = { channels = ["#general"] }
```

The `tools` value is `string | Record<string, unknown>` — loom doesn't
interpret it; the claiming provider does.

## File-based agents

`agent.toml` lives on disk; `runAgent` accepts the path:

```toml
[agent]
name = "sample-agent"
system_prompt = "./identity.md"

[harness]
provider = "test"

[session]
provider = "file"
path = "./session.jsonl"

[capabilities]
# Optional per-tool ceiling. Each tool's declared caps must fit inside
# its matching entry (using the tool's `capabilitiesContain`).
read_file = { paths = ["./"] }
write_file = { paths = ["./"] }

[tools]
read_file = { paths = ["./"] }
write_file = { paths = ["./"] }
bash = {}
```

```sh
node dist/cli/main.js audit  test/fixtures/sample-agent/agent.toml
node dist/cli/main.js prompt test/fixtures/sample-agent/agent.toml "hi"
```

## Capability semantics

- Each tool defines its own capability shape. `read_file`'s caps are
  `{ paths: string[] }`; an MCP-supplied `discord.send` might use
  `{ channels: string[] }`. Loom doesn't interpret the shape.
- Tools self-police at execute time. `read_file` rejects requests for
  paths outside its configured roots. The runtime doesn't enforce caps
  — the tool author does, in their own code.
- `[capabilities]` (optional, top-level) is a per-tool ceiling. When
  present, each tool's declared caps must fit inside the matching
  entry, checked at boot via the tool's `capabilitiesContain` (or a
  structural deep-subset default). Use it as a defense-in-depth rail
  against an extension bringing a tool with looser caps than you intended.



## Distributing extensions via npm / GitHub

A Loom extension is a regular npm package with a `loom.extension` field in
its `package.json` pointing at an entry that exports a `register()` function:

```json
{
  "name": "mcp-loom-extension",
  "type": "module",
  "main": "./dist/index.js",
  "loom": { "extension": "./dist/index.js" }
}
```

```js
// dist/index.js
export function register(api) {
  api.registerHarness({ name: "...", create(config, ctx) { /* ... */ } });
  api.registerSession({ name: "...", create(config, ctx) { /* ... */ } });
  api.addProvider({ /* ... */ });   // auto-activate a Provider for this agent
}
```

Activation is explicit (extensions run as the runtime trust class):

```toml
[extensions]
"mcp-loom-extension" = { servers = ["filesystem"] }
"@my-org/loom-foo"   = {}
```

Discovery walks `<manifest-dir>/node_modules` → `npm root -g` → `~/.loom/extensions`.

```sh
npm install mcp-loom-extension                  # local
npm install -g mcp-loom-extension               # global
npm install github:user/mcp-loom-extension      # any git ref
npm install file:./local-path                   # local checkout
```

`loom extensions list` enumerates packages with a `loom.extension` field.

## Design

The implementation follows the v0 / v1 design documents (four resources,
four interfaces, two faces, one external protocol, one security principle).
Reading order:

1. `src/types/` — ACP types, manifest types, the four interfaces.
2. `src/manifest/parser.ts`, `resolver.ts`, `capabilities.ts` — the manifest
   pipeline.
3. `src/runtime/` — system-prompt assembly, tool table, update sink.
4. `src/extensions/{harness,session}/*` — the pluggable extensions.
5. `src/sdk/run-agent.ts` — `runAgent()` ties it all together.
6. `src/acp/`, `src/server/`, `src/registry/`, `src/audit/` — v1 surfaces.

## License

MIT.
