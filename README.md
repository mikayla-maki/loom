# Glass

> A manifest-driven agent meta-harness.

Glass is a declarative runtime for composing LLM agents. It is built around
**four resources** (Harness, Session, Skill, Tool), **four interfaces** of the
same names, **two faces** (an in-process SDK and a JSON-RPC ACP server),
**one external protocol** (ACP), and **one security principle**: every scope
is sandboxed by default; tools are the only mechanism that grants capability.

## Status

This repository implements the **v0** + a substantial slice of **v1** of the
[design](#design). v0 ships:

- `agent.toml`, `SKILL.md`, and `tool.toml` parsers + transitive dependency
  resolver.
- Static capability validation (`[sandbox]` ceilings, fs/network/secrets/subagent).
- A `Runtime` that owns system-prompt assembly, session reads, update fan-out,
  and tool execution.
- Session extensions: `file` (JSONL append log) and `memory` (in-process).
- Harness extensions: `test` (deterministic, scripted), `anthropic`
  (Messages API via `fetch`), and `openai` (Chat Completions via `fetch`).
- Process-backed tools with strict env isolation: only declared secrets reach
  the tool; the parent's env is filtered to a system whitelist.
- Builtin tools: `bash`, `echo`, `read_file`, `secrets.get`, `spawn_subagent`.
- A CLI: `glass run`, `glass prompt`, `glass audit`, `glass acp serve`,
  `glass daemon`.
- An end-to-end **sample agent** under `test/fixtures/sample-agent`.

v1 layers on top of that:

- Skills declare `subagents` (inline mapping or `subagents.toml`).
- Recursive **capability audit** (`auditAgent` / `glass audit`).
- A `LocalRegistry` at `~/.glass/{skills,tools,agents}` plus bare-name
  resolution (the resolver tries name → registry → local path → builtin).
- An ACP wire protocol (server + client + `connectAcpUrl` for `acp://` and
  `acp+unix://` URLs).
- A daemon (Unix socket broker) with token-and-broker subagent invocation.

What is intentionally not yet implemented: OS-level sandbox enforcement
(macOS `sandbox-exec`, Linux Landlock/namespaces). The hooks are present in
the v0 capability-declaration model; engaging them is a flag flip away.

## Install / develop

```sh
npm install
npm run build
npm test                 # 28+ tests covering parser, resolver, runtime, ACP, audit
node dist/cli/main.js help
```

## End-to-end demo (no LLM required)

```sh
echo '{"sample_user_name":"world"}' > test/fixtures/sample-agent/.glass-secrets
node dist/cli/main.js audit  test/fixtures/sample-agent/agent.toml
node dist/cli/main.js prompt test/fixtures/sample-agent/agent.toml "hi"
```

The sample agent ships a `greeter` skill that wires two process-backed tools
(`greet`, `uppercase`) into the agent. The default harness is the `test`
harness (no LLM call); switch to `anthropic` or `openai` by editing
`agent.toml` and providing `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.

## SDK

```ts
import { runAgent } from "glass";

const agent = await runAgent("./agent.toml");
(async () => {
  for await (const u of agent.updates()) console.log(u);
})();
await agent.prompt("Hello, agent.");
await agent.close();
```

## Design

This implementation follows the v0 / v1 design documents (four resources,
four interfaces, two faces, one external protocol, one security principle).
The most important code reading order:

1. `src/types/` — ACP types, manifest types, the four interfaces.
2. `src/manifest/parser.ts`, `resolver.ts`, `capabilities.ts` — the
   manifest pipeline.
3. `src/runtime/` — system-prompt assembly, tool table, update sink.
4. `src/extensions/{harness,session}/*` — the pluggable extensions.
5. `src/sdk/run-agent.ts` — `runAgent()` ties it all together.
6. `src/acp/`, `src/daemon/`, `src/registry/`, `src/audit/` — v1 surfaces.

## License

MIT.
