// MCP server fixture used by Chunk 6 (secrets in env) tests.
// Exposes a `whoami` tool that reports the value of MOCK_API_KEY
// from the process environment, so tests can verify the parent
// (Loom) successfully injected the secret into the child.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "loom-test-mcp-env",
  version: "0.0.1",
});

server.registerTool(
  "whoami",
  {
    description: "Return the value of MOCK_API_KEY from the env.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text",
        text:
          typeof process.env.MOCK_API_KEY === "string"
            ? process.env.MOCK_API_KEY
            : "(unset)",
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
