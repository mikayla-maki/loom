# Loom

> A manifest-driven agent meta-harness.

Loom is a declarative runtime for composing LLM agents. It is built around
**four resources** (Harness, Session, Skill, Tool), **four interfaces** of the
same names, **two faces** (an in-process SDK and a JSON-RPC ACP server),
**one external protocol** (ACP), and **one security principle**: every scope
is sandboxed by what it declares; the agent's `[sandbox]` is an upper bound
the operator can tighten.

## Status

This repository implements the **v0** + most of **v1** of the
[design](#design). Highlights:

- **Single `AgentManifest` type** — file-parsed (`agent.toml` + `SKILL.md` +
  `tool.toml`) or constructed in-memory by an SDK consumer. Skills and tools
  may be expressed inline as nested objects OR as string refs.
- **Static capability validation** — `[sandbox]` ceilings on three axes
  (`filesystem`, `network`, `secrets`). Permissive by default: an absent
  `[sandbox]` table or absent axis means unconstrained on that axis.
- **`Runtime`** that owns system-prompt assembly, session reads, update
  fan-out, and tool execution.
- **Session extensions:** `file` (JSONL append log) and `memory` (in-process,
  the default if `[session]` is absent).
- **Harness extensions:** `test` (deterministic, scripted), `anthropic`
  (Messages API), `openai` (Chat Completions). Bring your own via the
  extension package mechanism.
- **Process-backed tools** with strict env isolation: only declared secrets
  reach the tool; the parent's env is filtered to a system whitelist.
- **Builtin tools:** `bash`, `echo`, `read_file`, `write_file`, `find`,
  `secrets.get`, `spawn_subagent`, `search_skills`, `add_skill`.
- **CLI:** `loom run`, `loom prompt`, `loom audit`, `loom acp serve`,
  `loom install`, `loom list`, `loom extensions`.
- An end-to-end **sample agent** under `test/fixtures/sample-agent`.

v1 layers:

- Skills declare `subagents` (inline mapping or `subagents.toml`).
- Recursive **capability audit** (`auditAgent` / `loom audit`).
- **`LocalRegistry`** at `~/.loom/{skills,tools,agents}` with bare-name
  resolution (the resolver tries inline → providers → local path → registry → builtin).
- **ACP wire protocol** (server + client + `connectAcpUrl` for `acp://` and
  `acp+unix://` URLs).
- **`LoomServer.embed()`** — an in-process broker that lets spawned tool
  subprocesses invoke subagents via the `loom-invoke` shim. Ephemeral
  socket; no persistent daemon. Started lazily only when a tool actually
  declares `subagent` capability.

What is intentionally not yet implemented: OS-level sandbox enforcement
(macOS `sandbox-exec`, Linux Landlock/namespaces). The capability declarations
already exist; engaging them at the OS level is a separate phase.

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
- `sandbox` → unconstrained on every axis (permissive)
- The `core` builtin skill (bash/read_file/write_file/find) auto-loads
  unless `agent.removeBuiltinTools = true`.

Tighten any of those when you want to:

```ts
await runAgent({
  agent: { name: "lockdown", removeBuiltinTools: true },
  harness: { provider: "anthropic", model: "claude-3-5-sonnet-latest" },
  session: { provider: "file", path: "./session.jsonl" },
  sandbox: { filesystem: [], network: ["api.anthropic.com"] },
  // ...
});
```

## Inline skills + tools

Skills and tools can be declared inline alongside the agent:

```ts
await runAgent({
  agent: { name: "delegator" },
  harness: { provider: "test", script: [/* ... */] },
  skills: {
    weather: {
      description: "Look up weather.",
      requires: {
        forecast: {
          description: "Fetch today's forecast for a city.",
          schema: { type: "object", required: ["city"], properties: { city: { type: "string" } } },
          invocation: { command: "/path/to/forecast-bin" },
          capabilities: { network: ["api.weather.gov"] },
        },
      },
    },
  },
});
```

Map keys (`weather`, `forecast`) are the canonical names. Mix and match
inline objects with string refs:

```ts
skills: {
  weather: { description: "...", requires: { forecast: "builtin" } },
  pre_existing: "../skills/something",
  by_name: "registry-skill-name",
}
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

[sandbox]
filesystem = ["./"]
network = []
secrets = ["sample_user_name"]

[skills]
greeter = "../skills/greeter"
```

```sh
echo '{"sample_user_name":"world"}' > test/fixtures/sample-agent/.loom-secrets
node dist/cli/main.js audit  test/fixtures/sample-agent/agent.toml
node dist/cli/main.js prompt test/fixtures/sample-agent/agent.toml "hi"
```

## Sandbox semantics

- **Absent table or axis** → unconstrained (`*`) for that axis. The minimal
  manifest is fully permissive.
- **Empty array** → explicitly nothing. `[sandbox] network = []` permits no
  network access at all.
- **Subagents** are *not* a sandbox axis. A skill's `subagents:` declaration
  is the contract; what a skill ships is what its tools can invoke. To veto
  a subagent, remove the skill.
- The auto-loaded `core` skill needs `filesystem = ["./"]`; if you set
  `sandbox.filesystem` to something tighter and don't `removeBuiltinTools`,
  the resolver fails with a hint pointing at the opt-out flag.

## Subagent invocation (the broker)

A skill can declare subagents:

```ts
skills: {
  research: {
    description: "Web research.",
    requires: { delegate: "./tools/delegate" },
    subagents: {
      compactor: "/abs/path/to/compactor/agent.toml",
      retriever: "registry-name",
      planner: "acp://planner.example.com:9000/planner",
    },
  },
}
```

A tool that declares `[tool.capabilities] subagent = ["compactor", ...]`
will be spawned with `LOOM_INVOKE_TOKEN` and `LOOM_INVOKE_SOCKET` env vars
plus a `loom-invoke` binary on PATH:

```sh
# inside the spawned tool subprocess
loom-invoke compactor "summarize this text"
```

The shim posts to the parent's broker socket; the parent validates the
token (skill-scoped to the calling tool's owning skill), dispatches the
subagent, and returns its final message on stdout. Tokens are minted per
invocation and revoked when the child exits.

The model can also invoke subagents directly via the in-process
`spawn_subagent` builtin (no broker needed; same registry).

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
