# @mcmaki/loom-sandbox

The enforcement layer of [Loom](https://github.com/mikayla-maki/loom), as a standalone library:

- **`bashSandboxPlan(grant)`** — the embeddable primitive: turns a capability grant into a platform sandbox spawn prefix (`sandbox-exec` on macOS, `bwrap` on Linux) plus a deny-by-default environment, with fail-closed reporting when a structured grant has no backend.
- **The command broker** — `setupCommandBroker(rows)` stands up the shim dir + unix socket that lets per-command grant rows follow a command into pipelines and interpreters, re-sandboxing each brokered invocation under its own row.
- **Env inheritance** — `buildEnv` and the two-tier allowlist (`ALWAYS_INHERITED_ENV` / `DEFAULT_INHERITED_ENV`) that govern what a sandboxed process sees.
- **`OutputBuffer`** — bounded, tail-biased output discipline for terminal-style tools, with optional temp-file spillover.

Grant types come from [`@mcmaki/loom-capabilities`](https://www.npmjs.com/package/@mcmaki/loom-capabilities); the full agent runtime that wires this under its `bash` tool is [`@mcmaki/loom`](https://www.npmjs.com/package/@mcmaki/loom).
