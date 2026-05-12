# MCP agent — using an external MCP server

A complete, runnable Loom agent wired up to a stand-alone
[Model Context Protocol](https://modelcontextprotocol.io) server.
This is the canonical tour of Loom's built-in `mcp-server`
meta-provider: one `[providers]` entry spawns an MCP child process,
and each `[tools.X]` entry exposes one of its tools to the model —
optionally renamed, narrowed, or pre-bound via `[capabilities]`.

The example is fully self-contained: both the manifest **and** the
MCP server live inside this directory.

## Layout

```
mcp-agent/
├── README.md
├── agent.toml          # the Loom manifest; refs ./mcp-server
└── mcp-server/         # a stand-alone MCP server, six tools
    ├── README.md
    ├── server.ts       # source
    ├── server.js       # committed build output
    ├── package.json
    └── tsconfig.json
```

The MCP server has no knowledge of Loom whatsoever — it speaks the
protocol over stdio using the official
[`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk).
The whole point is that Loom consumes any MCP server transparently;
the manifest is what wires it in.

## Run it

From the repo root (`loom/`):

```sh
# Build the loom CLI + the demo MCP server.
npm run build
(cd examples/mcp-agent/mcp-server && npm install && npm run build)

# Audit (no API key needed) — walks the manifest, narrows schemas,
# prints what the model will see plus any tools the server
# advertised but this manifest didn't expose.
MOCK_API_KEY=demokey node dist/cli/main.js audit examples/mcp-agent/agent.toml

# Run it for real.
ANTHROPIC_API_KEY=... MOCK_API_KEY=demokey \
  node dist/cli/main.js run examples/mcp-agent/agent.toml
```

To discover an MCP server's full tool list and get a paste-and-prune
TOML snippet:

```sh
node dist/cli/main.js mcp inspect ./examples/mcp-agent/mcp-server/server.js
```

## What it shows

The MCP server exposes **six** tools chosen to exercise each new
feature of Loom's MCP integration. The manifest is annotated
chunk-by-chunk; here's the high-level map:

| Tool | MCP-side schema | What the manifest does with it |
|---|---|---|
| `echo` | `text: string` | Direct passthrough. Proves the configured-factory `[providers]` form works at all. |
| `read_document` | `doc_id, format?` | Exposed twice — once unrestricted, once renamed to `read_welcome_doc` with `doc_id` pre-bound (the model sees a one-arg tool). |
| `query_table` | `table, limit?` | Exposed under two model-facing names (`query_users`, `query_orders`) via `mcp_tool` rename, each with `table` pre-bound to a different literal. |
| `set_status` | `status: string` | Constrained to `enum: ["online", "away"]` via the array form of the capability grant. The MCP server's schema is permissive; Loom narrows it before the model ever sees it. |
| `send_alert` | `channel, message` | Requires `MOCK_API_KEY` in the server's env. Supplied via `secrets = { MOCK_API_KEY = "MOCK_API_KEY" }` on the `[providers]` entry; Loom resolves the secret and injects it at spawn time. |
| `dangerous_delete` | `path: string` | **Advertised but deliberately omitted** from `[tools]`. The model never sees it. `loom audit` lists it under "advertised but unexposed". |

### Capability grant shapes

The capability grant gains a shape-dependent interpretation for
MCP-backed tools:

| Grant | Effect on the model-visible schema |
|---|---|
| `"*"`                  | full schema, no binding |
| `{ arg = "<literal>" }`  | arg removed from schema, merged at execute |
| `{ arg = ["a","b"] }`    | arg constrained to enum: `["a","b"]` |
| `{ arg = "*" }`          | arg unchanged |
| (arg absent)             | arg unchanged |

Schema narrowing is what the model sees; binding is what's merged
back at execute time. Validation rejects the model trying to
override a bound arg.

## See also

- [`./mcp-server/README.md`](./mcp-server/README.md) — building,
  running, and inspecting the MCP server standalone.
- The root [`README.md`](../../README.md) section **"MCP servers"**
  for the broader MCP integration reference.
- [`../../internal-docs/mcp-provider-implementation-prompt.md`](../../internal-docs/mcp-provider-implementation-prompt.md)
  — the design doc the manifest annotations cross-reference.
