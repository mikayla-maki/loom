# Loom

> A manifest-driven agent meta-harness.

Loom is a declarative runtime for composing LLM agents. The user writes
an `agent.toml` (or constructs an `AgentManifest` in JS); loom parses it,
resolves secrets, and instantiates a running agent.

The user-facing model fits in a paragraph: a Loom agent is composed
from **providers** — npm packages, local paths, or built-in code that
contribute *harnesses*, *sessions*, and *tool providers*. The
`[providers]` table optionally gives local handles to packages you
reference more than once. Each of `[harness]`, `[session]`, and
`[tools.X]` carries a `provider` field that names which provider
supplies it. `[capabilities]` is the permission ceiling for the agent
and any subagents it spawns.

See `internal-docs/manifest-v5.md` for the canonical manifest design.


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
  name: "demo",
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
  explicit `tools` table to opt out.
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
# Each entry is `name = config`. Loom routes (name, config) to a
# Tools instance — either the built-in (no `provider` field) or one
# materialised from a provider package.
bash = {}
read_file = { paths = ["./src", "./test"] }
# Tools added by an inline-anonymous provider reference:
# fetch_url = { provider = "@my-org/loom-fetch", apiKey = { secret = "FETCH_KEY" } }
```

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
# Built-ins claimed by tool name; no `provider` field needed.
bash       = {}
read_file  = {}
write_file = {}

[capabilities]
# Per-tool grants. "*" = unrestricted. Absent kind = tool's smart
# default. Empty {} = nothing granted (tools with `requires` fail
# boot).
read_file  = { paths = ["./"] }
write_file = { paths = ["./"] }
bash       = { subprocess = "*", paths = ["./"], env = ["PATH", "HOME"] }
```

```sh
node dist/cli/main.js audit  test/fixtures/sample-agent/agent.toml
node dist/cli/main.js prompt test/fixtures/sample-agent/agent.toml "hi"
```

## Capability semantics

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



## Distributing providers via npm / GitHub

A Loom provider is an npm package with a `loom.provider` field in
its `package.json` pointing at an entry that exports a `register()`
function:

```json
{
  "name": "@my-org/loom-mcp",
  "type": "module",
  "main": "./dist/index.js",
  "loom": { "provider": "./dist/index.js" }
}
```

```js
// dist/index.js
export function register(api) {
  api.registerTools({
    name: "@my-org/loom-mcp",
    async create(config, ctx, secrets) { /* ... → Tools */ },
  });
  api.registerHarness({
    name: "@my-org/loom-mcp",
    create(config, ctx, secrets) { /* ... → Harness */ },
  });
  api.registerSession({
    name: "@my-org/loom-mcp",
    create(config, ctx, secrets) { /* ... → Session */ },
  });
}
```

Activation is explicit (providers run as the runtime trust class):

```toml
[providers]
mcp = { npm = "@my-org/loom-mcp", version = "^1.2" }

[tools]
list_files = { provider = "mcp", server = "filesystem" }
```

Discovery walks `<manifest-dir>/node_modules` → `npm root -g` →
`~/.loom/providers`.

```sh
npm install @my-org/loom-mcp                       # local
npm install -g @my-org/loom-mcp                    # global
npm install github:my-org/loom-mcp                 # any git ref
npm install file:./local-path                      # local checkout
```

`loom providers list` enumerates packages with a `loom.provider` field.

## Design

The implementation follows the manifest-v5 design (one reference
word, one declaration table, one resolution rule). Reading order:

1. `src/types/` — ACP types, manifest types, the runtime interfaces.
2. `src/manifest/parser.ts`, `resolver.ts`, `capabilities.ts` — the manifest
   pipeline.
3. `src/runtime/` — system-prompt assembly, tool table, update sink,
   shared boot helpers.
4. `src/builtins/{harness,session}/*` — built-in harness/session factories.
5. `src/providers/loader.ts` — provider package discovery and registration.
6. `src/sdk/run-agent.ts` — `runAgent()` ties it all together.
7. `src/acp/`, `src/cli/`, `src/audit/` — surfaces on top.

## License

MIT.
