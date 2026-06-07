# minimal-agent

The smallest useful Loom agent, and the recommended starting point. A single
`agent.toml` — no provider package, no build step, no persistence. Just the
built-in file/shell tools, scoped to the current directory, behind an Anthropic
harness.

```sh
loom audit examples/minimal-agent/agent.toml          # see what it can do, no model call
ANTHROPIC_API_KEY=... loom run examples/minimal-agent/agent.toml
```

Read the manifest top to bottom — it's the whole agent. Then copy it and grow
from here:

- **Persistence / recall across runs** → see [`../full-agent/`](../full-agent/),
  which adds a notes provider and web search.
- **Building the same thing in code** → see [`../sdk-agent/`](../sdk-agent/).
- **Wiring in an MCP server** → see [`../mcp-agent/`](../mcp-agent/).

Everything you can configure — harness, session layers, tools, and the
capability grants that bound them — is documented in the top-level
[README](../../README.md).
