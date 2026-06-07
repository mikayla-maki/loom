---
name: dns-lookup
description: Look up DNS records with dig. Use when the user asks what a
  domain resolves to, or wants to inspect A, AAAA, MX, TXT, or NS records.
metadata:
  loom.tools: |
    bash = { capabilities = { commands = ["dig"], network = "*" } }
---

# DNS lookup

Use the `bash` tool to invoke `dig`. Its network grant is bound to the
`dig` command itself, so it holds even inside a pipeline — `dig +short
example.com | sort` works. Common invocations:

- Resolve a name: `dig +short example.com`
- Specific record type: `dig +short example.com MX`
- Trace delegation: `dig +trace example.com`
- Pipe into other commands: `dig +short example.com | tail -1`
