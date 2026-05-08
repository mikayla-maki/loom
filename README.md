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
- **Capabilities v2** — `[capabilities]` is the single source of truth
  for what each tool may do. Per-tool grants are `"*"` (whole-tool
  unrestricted), `{}` (nothing), or a per-kind map
  (`{ paths = ["./"], subprocess = "*" }`). Each tool declares
  `requires` (kinds it must have) and `optional` (kinds it may use);
  the boot guard checks every required kind is granted. Tools also
  derive their model-facing description and input schema from the
  grant — same JSON drives validation, self-policing, and the
  agent's mental model.
- **`[agent].secrets` allowlist** — mirrors capability star/list
  semantics. Absent or `"*"` = no ceiling; an array = the closure of
  secret names tools may resolve.
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

A Loom agent is composed along three orthogonal axes:

1. **Installation.** `[extensions]` declares npm packages that
   register providers, harnesses, and sessions. The native provider
   ships with Loom.
2. **Wiring.** `[tools]` maps a model-facing name to a
   `(provider, config)` pair. The config is the tool's runtime
   defaults (region, timeouts, server URL) — NOT capability data.
3. **Grant.** `[capabilities]` says what each named tool may do, in a
   tool-defined kind vocabulary (`paths`, `subprocess`, `network`,
   `buckets`, ...). The grant flows to the tool at construction time;
   the tool self-polices and exposes a partially curried surface based
   on what it was granted (multi-bucket grant → enum in input schema;
   single-bucket grant → bucket bound, only key in schema).

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
- `tools` → the default builtin set (`bash`, `read_file`, `write_file`,
  `find`) auto-loads when the field is absent, with a parallel default
  capability bundle (FS tools → `paths = ["./"]`; bash →
  `subprocess = "*", paths = ["./"]` and SAFE_DEFAULT env). Declare an
  explicit `tools` table (even empty) to opt out.
- `capabilities` → absent. When `[tools]` is also absent, the default
  cap bundle applies; when `[tools]` is declared, no defaults apply
  and tools that have `requires` must be granted explicitly.

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

[tools]
# Wiring: which provider claims the name + non-cap config. Caps live
# in [capabilities] below; do not duplicate.
read_file  = "builtin"
write_file = "builtin"
bash       = "builtin"

[capabilities]
# v2 grants. "*" = unrestricted. Absent kind = tool's smart default.
# Empty {} = nothing granted (tools with requires fail boot).
read_file  = { paths = ["./"] }
write_file = { paths = ["./"] }
bash       = { subprocess = "*", paths = ["./"], env = ["PATH", "HOME"] }
```

```sh
node dist/cli/main.js audit  test/fixtures/sample-agent/agent.toml
node dist/cli/main.js prompt test/fixtures/sample-agent/agent.toml "hi"
```

## Capability semantics (v2)

A capability grant is one of:

- `"*"` — whole-tool unrestricted (every kind allowed; sandbox
  engagement opts out).
- `{}` — nothing granted. Tools with non-empty `requires` fail boot.
- `{ kind = value }` — per-kind grant. Each value is `"*"` (kind
  unrestricted), an allowlist array, or a structured object
  (kind-defined). Absent kinds are denied (or fall to the tool's
  smart default, when one is defined).

Tool authors declare:

- `requires: string[]` — kinds the tool MUST have to function. Boot
  guard fails when missing.
- `optional: string[]` — kinds the tool MAY use if granted. Inform
  audit + (for bash) sandbox-profile derivation; absence is fine.

Kinds are tool-defined (open vocabulary). Examples in tree:

| Kind         | Used by              | Star/list/absent semantics                                    |
|--------------|----------------------|---------------------------------------------------------------|
| `paths`      | `read_file`/`write_file`/`find`/`bash` | `"*"` any FS; `["./"]` allowlist; absent → smart default `["./"]` |
| `subprocess` | `bash`               | `"*"` allow exec; absent → deny (boot fails: bash requires it) |
| `network`    | `bash`               | `"*"` allow; `[]` deny; absent → deny                         |
| `env`        | `bash`               | `"*"` full process.env; `["PATH", "AWS_*"]` exact + prefix; absent → SAFE_DEFAULT subset |

Tools self-police on every call by reading `this.capabilities`, and
derive their description/input schema from the grant — a
single-bucket S3 grant binds the bucket; a multi-bucket grant exposes
an `enum`; an unrestricted grant opens the full surface. The same
JSON drives the model's mental model, the runtime check, and (for
bash, in a follow-up) the OS-level sandbox profile.



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
