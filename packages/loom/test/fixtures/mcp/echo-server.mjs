// Minimal MCP server fixture used by the Loom MCP factory tests.
// Speaks JSON-RPC over stdio via the official SDK. Exposes one tool,
// `echo`, returning its input verbatim. Self-contained so the test
// suite can spawn it without depending on the example tour server.
//
// Relies on `@modelcontextprotocol/sdk` + `zod` resolving from
// loom/node_modules (npm hoists `zod` as a peer dep of the SDK).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "loom-test-mcp-echo",
  version: "0.0.1",
});

server.registerTool(
  "echo",
  {
    description: "Return the input verbatim.",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: "text", text }],
  }),
);

server.registerTool(
  "add",
  {
    description: "Add two integers.",
    inputSchema: {
      a: z.number(),
      b: z.number(),
    },
  },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
  }),
);

await server.connect(new StdioServerTransport());
