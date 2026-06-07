---
name: json-wrangler
description: Query, filter, and reshape JSON files with jq. Use when the
  user wants to extract fields from JSON, transform JSON structure, or
  inspect large JSON documents.
compatibility: Requires jq on PATH.
---

# JSON wrangling

A dedicated `jq` tool is available (argv-only — pass the program and file
as plain arguments, no shell features). Examples:

- Extract a field: program `.dependencies | keys`, file `package.json`
- Compact print: program `.`, args `-c`, file `data.json`

For multi-step transforms prefer one jq program over chaining calls.

The tool declarations for this skill live in the `loom.toml` sidecar next
to this file — the "enhance a skill you didn't author" form.
