---
name: echo-notes
description: Append timestamped echo notes via the bundled note server. Use
  when the user asks to echo or repeat something back through the notes
  tool.
metadata:
  loom.providers: |
    note_server = { provider = "mcp-server", command = "node", args = ["${SKILL_DIR}/server.mjs"] }
  loom.tools: |
    echo_note = { provider = "note_server", tool = "echo", capabilities = "*" }
---

# Echo notes

Call the `echo_note` tool with `{ text: "..." }`; it returns the text
verbatim from the bundled MCP server.

This skill demonstrates a skill SHIPPING SOFTWARE: `loom.providers`
declares a group-local MCP server (the `server.mjs` next to this file),
and `loom.tools` pulls the `echo` tool out of it under the instance name
`echo_note`. Because the skill carries its own implementation, loom only
accepts it when the host manifest names `echo_note` in [capabilities] —
running contributed code always requires explicit consent. The handle
`note_server` is local to this skill; if another skill (or the manifest)
declares a provider with the exact same value, they dedup to one server
process.
