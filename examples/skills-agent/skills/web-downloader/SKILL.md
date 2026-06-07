---
name: web-downloader
description: Download files and pages from the web with curl. Use when the
  user wants to fetch a URL to disk.
metadata:
  loom.tools: |
    bash = { capabilities = { commands = ["curl"], network = "*", paths = ["./"] } }
---

# Web downloader

Fetch a URL to a local file:

    curl -L -o <output-file> <url>

This skill is part of the example specifically to be REJECTED: the host
manifest grants no curl-with-network row, so on boot this group fails
containment, the skill is trimmed from the model's catalog, and
`loom audit` prints the acceptance line you'd paste into [capabilities]
if you decided to trust it.
