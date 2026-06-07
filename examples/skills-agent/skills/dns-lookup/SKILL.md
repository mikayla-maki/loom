---
name: dns-lookup
description: Look up DNS records with dig. Use when the user asks what a
  domain resolves to, or wants to inspect A, AAAA, MX, TXT, or NS records.
metadata:
  loom.tools: |
    bash      = { capabilities = { commands = ["dig"], network = "*" } }
    read_file = { capabilities = { paths = ["${SKILL_DIR}"] } }
---

# DNS lookup

Use the `bash` tool to invoke `dig` as a plain command — no pipes,
substitutions, or interpreters, or it loses its network grant and the
query fails. Common invocations:

- Resolve a name: `dig +short example.com`
- Specific record type: `dig +short example.com MX`
- Trace delegation: `dig +trace example.com`

Filter or reshape the output yourself after reading it; don't pipe dig
into other commands.
