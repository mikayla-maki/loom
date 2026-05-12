/**
 * `loom-mcp-example-server` — a tiny MCP server, useful as a fixture
 * for exercising Loom's `mcp-server` built-in meta-provider.
 *
 * This is a stand-alone MCP server. It speaks the protocol over
 * stdio and has no knowledge of Loom whatsoever. The whole point is
 * that Loom consumes any MCP server transparently; the manifest that
 * lives next door (`examples/mcp-agent/agent.toml`) is what wires
 * it in.
 *
 * The tools are chosen so that each one exercises a distinct feature
 * of the MCP integration described in
 * `internal-docs/mcp-provider-implementation-prompt.md`:
 *
 *   - `echo(text)`
 *       Trivial direct passthrough. Exists to prove the manifest's
 *       configured-factory `[providers]` form works at all
 *       (Chunk 1).
 *
 *   - `read_document(doc_id, format?)`
 *       Multi-arg tool. Used in the manifest twice: once as
 *       `read_document` (full schema, model picks doc_id and
 *       format) and once as `read_welcome_doc` via `mcp_tool` rename
 *       with `doc_id` pre-bound via `[capabilities]`. The renamed
 *       form is the load-bearing demo for Chunk 5 (capability-based
 *       partial application: the model sees a one-arg tool whose
 *       inputSchema has been narrowed).
 *
 *   - `query_table(table, limit?)`
 *       Multi-arg tool exposed under two different model-facing
 *       names — `query_users` and `query_orders` — each with `table`
 *       pre-bound to a different literal. Reinforces the "same MCP
 *       tool, multiple narrowed surfaces" story and demonstrates
 *       Chunk 3's `mcp_tool` rename in a realistic shape.
 *
 *   - `set_status(status)`
 *       `status` is a free string here at the protocol level. The
 *       manifest constrains it with an array grant
 *       (`status = ["online", "away"]`) which Chunk 5 translates
 *       into a JSON Schema `enum`. Demonstrates the array form of
 *       the capability grant.
 *
 *   - `send_alert(channel, message)`
 *       Requires a `MOCK_API_KEY` in the process env. If absent,
 *       the tool returns an `isError: true` result. The manifest
 *       supplies it via the `secrets` config on `[tools.send_alert]`
 *       (Chunk 6) — Loom's MCP factory injects matching secrets
 *       into the child's env at spawn time.
 *
 *   - `dangerous_delete(path)`
 *       Advertised by the server but deliberately NOT listed in
 *       the manifest's `[tools]` block. This is the static-
 *       enumeration policy in action: the model cannot see or call
 *       a tool unless the manifest explicitly names it, even when
 *       the underlying MCP server offers it. The presence of this
 *       tool is what lets `loom audit` show "1 advertised tool not
 *       exposed" and what makes `loom mcp inspect` useful.
 *
 * Run standalone:
 *   $ MOCK_API_KEY=demo node ./server.js
 *
 * It'll sit on stdin waiting for JSON-RPC. Combine with the official
 * MCP inspector (`npx @modelcontextprotocol/inspector node ./server.js`)
 * to poke at it interactively.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// ─── Fake data ────────────────────────────────────────────────────────────
//
// Hard-coded in-memory mocks so the server is self-contained. A real
// MCP server would talk to a filesystem, database, or remote API
// here — the shape of the integration is identical.
const DOCUMENTS = {
    welcome: {
        title: "Welcome",
        body: "Welcome to the Loom MCP example. This document is read by the " +
            '`read_document` tool. Pre-binding `doc_id = "welcome"` via ' +
            "[capabilities] is what turns the two-arg MCP tool into a " +
            "no-arg model-visible tool.",
    },
    changelog: {
        title: "Changelog",
        body: "- v0.1.0  Initial example MCP server.\n" +
            "- v0.0.1  Pre-history; nothing of note.",
    },
    roadmap: {
        title: "Roadmap",
        body: "Future work: HTTP transport, MCP resources & prompts, " +
            "tool-call streaming. None of this is needed for the v1 " +
            "integration.",
    },
};
const TABLES = {
    users: [
        { id: 1, name: "Ada Lovelace", email: "ada@example.com" },
        { id: 2, name: "Alan Turing", email: "alan@example.com" },
        { id: 3, name: "Grace Hopper", email: "grace@example.com" },
    ],
    orders: [
        { id: 101, user_id: 1, total_cents: 1299, status: "shipped" },
        { id: 102, user_id: 2, total_cents: 4500, status: "pending" },
        { id: 103, user_id: 3, total_cents: 999, status: "shipped" },
    ],
};
// MCP servers MUST keep stdout reserved for the JSON-RPC transport.
// Any logging goes to stderr.
function log(...args) {
    process.stderr.write(args.map((a) => String(a)).join(" ") + "\n");
}
// ─── Server + tool registrations ──────────────────────────────────────────
const server = new McpServer({
    name: "loom-mcp-example-server",
    version: "0.1.0",
});
// 1. echo — trivial passthrough. Useful sanity check.
server.registerTool("echo", {
    title: "Echo",
    description: "Return the input text unchanged. Useful as a sanity check.",
    inputSchema: {
        text: z.string().describe("Any text. Returned verbatim."),
    },
}, async ({ text }) => ({
    content: [{ type: "text", text }],
}));
// 2. read_document — multi-arg tool, ideal for partial-application demos.
server.registerTool("read_document", {
    title: "Read document",
    description: "Read one of the mock documents by id. Returns the document's " +
        "title and body. `format` controls whether the response is plain " +
        "text or a JSON envelope.",
    inputSchema: {
        doc_id: z
            .string()
            .describe('Identifier of the document to read (e.g. "welcome").'),
        format: z
            .enum(["text", "json"])
            .optional()
            .describe('Response format. Defaults to "text".'),
    },
}, async ({ doc_id, format }) => {
    const doc = DOCUMENTS[doc_id];
    if (!doc) {
        return {
            content: [{ type: "text", text: `No document with id "${doc_id}".` }],
            isError: true,
        };
    }
    if (format === "json") {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ doc_id, ...doc }, null, 2),
                },
            ],
        };
    }
    return {
        content: [{ type: "text", text: `# ${doc.title}\n\n${doc.body}` }],
    };
});
// 3. query_table — multi-arg tool exposed under several narrowed names.
server.registerTool("query_table", {
    title: "Query table",
    description: "Return up to `limit` rows from the named mock table. Available " +
        'tables: "users", "orders".',
    inputSchema: {
        table: z.string().describe("Table name. One of: users, orders."),
        limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Maximum number of rows to return. Defaults to all."),
    },
}, async ({ table, limit }) => {
    const rows = TABLES[table];
    if (!rows) {
        return {
            content: [{ type: "text", text: `Unknown table "${table}".` }],
            isError: true,
        };
    }
    const sliced = typeof limit === "number" ? rows.slice(0, limit) : rows;
    return {
        content: [{ type: "text", text: JSON.stringify(sliced, null, 2) }],
    };
});
// 4. set_status — single string arg, narrowed by an enum via the manifest.
//
// The MCP-side schema deliberately accepts ANY string. The manifest's
// `[capabilities].set_status = { status = ["online", "away"] }`
// array grant is what restricts the model to a subset via
// JSON Schema `enum`.
server.registerTool("set_status", {
    title: "Set status",
    description: "Set the user's presence status. The MCP server accepts any " +
        "string; the manifest is expected to constrain valid values " +
        "via [capabilities].",
    inputSchema: {
        status: z.string().describe("New status value."),
    },
}, async ({ status }) => ({
    content: [{ type: "text", text: `Status updated to "${status}".` }],
}));
// 5. send_alert — needs MOCK_API_KEY in the env, supplied via Loom's
//    `secrets` mechanism. Without it, the tool returns isError.
server.registerTool("send_alert", {
    title: "Send alert",
    description: "Send an alert message to a channel. Requires MOCK_API_KEY in the " +
        "environment; Loom supplies it via the `secrets` config on the " +
        "[tools.send_alert] entry.",
    inputSchema: {
        channel: z.string().describe("Channel name (e.g. #ops)."),
        message: z.string().describe("Alert text."),
    },
}, async ({ channel, message }) => {
    const apiKey = process.env["MOCK_API_KEY"];
    if (!apiKey) {
        return {
            content: [
                {
                    type: "text",
                    text: "MOCK_API_KEY missing from server env. Configure it via " +
                        '`secrets = { MOCK_API_KEY = "MOCK_API_KEY" }` on the ' +
                        "[tools.send_alert] entry in the manifest.",
                },
            ],
            isError: true,
        };
    }
    // We don't actually call anything; this is a demo. The key just
    // proves the secret made it across.
    return {
        content: [
            {
                type: "text",
                text: `[mock alert] channel=${channel} message=${JSON.stringify(message)} ` +
                    `(authenticated as ${apiKey.slice(0, 4)}…)`,
            },
        ],
    };
});
// 6. dangerous_delete — advertised but expected to be UNLISTED in the
//    manifest. This is the static-enumeration policy: the model cannot
//    see this tool unless the agent author opts in by adding a
//    [tools.dangerous_delete] entry.
server.registerTool("dangerous_delete", {
    title: "Dangerous delete",
    description: "Pretend to delete a path. Deliberately omitted from the demo " +
        "manifest so `loom audit` can show it as advertised-but-unexposed.",
    inputSchema: {
        path: z.string().describe("Path to delete (mock; does nothing)."),
    },
}, async ({ path }) => ({
    content: [
        {
            type: "text",
            text: `(mock) would have deleted ${path}. No-op.`,
        },
    ],
}));
// ─── Entry point ─────────────────────────────────────────────────────────
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log("loom-mcp-example-server ready " +
        `(MOCK_API_KEY ${process.env["MOCK_API_KEY"] ? "set" : "unset"})`);
}
main().catch((err) => {
    log("fatal:", err.stack ?? String(err));
    process.exit(1);
});
