# loom-mcp-example-server

A tiny MCP server, used as a fixture for the
[`agent.toml`](../agent.toml) tour of Loom's built-in `mcp-server`
meta-provider in the sibling `mcp-agent/` example.

This is a **stand-alone MCP server** — it speaks the protocol over
stdio using the official
[`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
and has no knowledge of Loom whatsoever. The whole point is that
Loom consumes any MCP server transparently; the manifest next door
is what wires it in.

## What's in the box

Six tools, each chosen to exercise a distinct feature of the MCP
integration described in
[`internal-docs/mcp-provider-implementation-prompt.md`](../../internal-docs/mcp-provider-implementation-prompt.md):

| Tool | MCP schema (args) | What it demonstrates in the manifest |
|---|---|---|
| `echo` | `text: string` | Direct passthrough — `[providers]` configured-factory form works at all (Chunk 1). |
| `read_document` | `doc_id: string, format?: "text"\|"json"` | Used twice: full passthrough AND under a renamed name (`read_welcome_doc`) with `doc_id` pre-bound via `[capabilities]`. Load-bearing demo for capability-based partial application (Chunk 5). |
| `query_table` | `table: string, limit?: number` | Exposed under two model-facing names (`query_users`, `query_orders`) via the `mcp_tool` rename, each with `table` pre-bound to a different literal (Chunks 3 + 5). |
| `set_status` | `status: string` | The MCP server's schema is permissive; the manifest narrows it to `enum: ["online", "away"]` via an array capability grant (Chunk 5). |
| `send_alert` | `channel: string, message: string` | Requires `MOCK_API_KEY` in the process env. The manifest supplies it via `secrets = { MOCK_API_KEY = "MOCK_API_KEY" }` on the `[tools.send_alert]` entry (Chunk 6). |
| `dangerous_delete` | `path: string` | Advertised but deliberately **not** listed in the manifest's `[tools]`. The model never sees it. Demonstrates the static-enumeration policy (Chunk 3 / `loom mcp inspect` rationale). |

## Build & run

```sh
npm install        # pulls @modelcontextprotocol/sdk + zod
npm run build      # tsc → server.js
node ./server.js   # speaks JSON-RPC on stdin/stdout
```

The compiled `server.js` is committed; in steady state you only
need `npm install` once (or `npm run dev` while iterating).

## Try it out without Loom

Use the official inspector to poke at the server interactively:

```sh
MOCK_API_KEY=demokey npx @modelcontextprotocol/inspector node ./server.js
```

Or hand-spoke JSON-RPC at it:

```sh
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node ./server.js
```

## How Loom will see it

The companion manifest at [`../agent.toml`](../agent.toml) drives
this server entirely through:

```toml
[providers]
mock_server = { provider = "mcp-server", command = "node", args = ["./mcp-server/server.js"] }
```

…and a `[tools.X]` entry per exposed tool. See the manifest for
the full annotated walkthrough.
