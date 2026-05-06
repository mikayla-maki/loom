# Loom v1 — Expansion points

This document describes capabilities planned beyond
[v0](./design-v0.md). Each is structurally reachable from the v0 architecture
without reshaping the four-resource model. None is required for a working
personal-companion agent on a single trusted machine; each becomes important
when usage extends beyond that case — third-party skills, multi-machine
deployment, performance-sensitive sub-agent invocation.

The v1 work groups into five themes:

1. Hardened sub-agent invocation
2. OS-level sandbox enforcement
3. Long-running Loom as a daemon
4. Registry and naming
5. Network-located agents over ACP

A sixth section — *Beyond v1* — sketches the further-out compositions the v1
primitives unlock without committing to building them.

---

## 1. Hardened sub-agent invocation

V0's `[tool.capabilities] subagent = ...` is declared but not enforced. A
tool subprocess can shell out to `loom run --inline ...` and spawn arbitrary
agents, escaping the parent's `[sandbox]` ceiling. This is fine for
one-operator use, but breaks the moment a third-party skill enters the
picture.

V1 closes the gap with three changes.

### 1a. Skills declare their sub-agents

`SKILL.md` gains a `subagents` field — either an inline map or a path to a
registry file:

```md
---
name: memory
description: Long-term memory with LLM-assisted compaction.
requires:
  memory.recall: ../../tools/memory-recall
  memory.compact: ../../tools/memory-compact
subagents: ./subagents.toml
---
```

```toml
# subagents.toml
compactor   = "./compactor/agent.toml"
retriever   = "./retriever/agent.toml"
reorganizer = "./reorganizer/agent.toml"
```

Layout:

```
memory-skill/
├── SKILL.md
├── subagents.toml
├── compactor/
│   ├── agent.toml
│   └── identity.md
├── retriever/
│   └── agent.toml
└── reorganizer/
    └── agent.toml
```

A skill ships its capabilities (tools + sub-agents) as a closed set. The
skill's tools may invoke only the named sub-agents declared here.

### 1b. Capability bubble-up

At parent agent load time, Loom walks every skill's `subagents`, unions them
into a required-capability set, and validates against the parent's
`[sandbox].subagent` ceiling:

```toml
[sandbox]
subagent = ["compactor", "retriever"]   # by name
# or:
# subagent = "*"                          # any declared by skills (orchestrator-style)
# or:
# subagent = ["./agents/**/*.toml"]       # by glob
```

The full reachable capability surface is computable statically by recursive
walk:

```ts
function auditAgent(manifestPath: string): CapabilityTree {
  const manifest = parseToml(manifestPath);
  const own = manifest.sandbox ?? {};

  const subagentTrees = collectSkills(manifest.skills)
    .flatMap(skill => Object.values(resolveSubagents(skill)))
    .map(subagentPath => auditAgent(subagentPath));   // recurse

  return {
    own: {
      filesystem: own.filesystem ?? [],
      network:    own.network    ?? [],
      secrets:    own.secrets    ?? [],
    },
    transitive: subagentTrees,
  };
}
```

Pre-flight: walk the root manifest, see every reachable manifest, answer
"what hosts could this tree hit? what paths could it write?" without running
anything. CI on agent definitions becomes possible.

### 1c. Token-and-broker invocation

In v0, tools shell out to `loom run` directly — fine because the operator
is the only one writing skills. In v1, the runtime mediates:

```
parent Loom (running)
   │
   │  binds Unix socket at $XDG_RUNTIME_DIR/loom-<rand>.sock
   │  generates per-tool token bound to:
   │     - skill that owns this tool
   │     - sub-agents that skill is allowed to invoke
   │     - parent's capability ceiling
   │
   ├─ spawns memory.compact tool with:
   │     env:  LOOM_INVOKE_TOKEN=<opaque>
   │     PATH: /private/tool-shim:...   (no real `loom` binary)
   │     stdin: JSON input
   │
   │  tool runs `loom-invoke compactor --prompt "..."`
   │     │
   │     ├─ loom-invoke reads LOOM_INVOKE_TOKEN
   │     ├─ connects to loom socket
   │     ├─ sends ACP {scope: "compactor", prompt: "...", token: <opaque>}
   │     │
   │     parent resolves token → looks up skill → checks "compactor"
   │       is in the skill's declared subagents → runs the sub-agent →
   │       streams result back over socket
   │     │
   │     └─ loom-invoke prints final message to stdout
   │
   └─ tool captures stdout, returns to parent
```

Properties:

- Tools never see API keys.
- Tools cannot escalate by reading env — the token is opaque and scoped.
- Tools cannot pivot — the token authorizes only the sub-agents declared by
  the calling skill.
- Auditable — walk the agent.toml, follow skills, see every reachable
  sub-agent. The capability surface is the whole tree, statically.

### 1d. Three resolution modes for sub-agent references

A `subagents` entry can resolve as:

```toml
[skills.research.subagents]
compactor    = "compactor"                       # registry name (see §4)
fact-check   = "./agents/fact-check.toml"        # local path
quick-think  = { inline = "..." }                # inline literal manifest
```

The runtime tries name → path → inline. Same field, same capability check,
three ergonomics for three situations. (A fourth — ACP URL — appears in §5.)

---

## 2. OS-level sandbox enforcement

V0 validates `[sandbox]` capabilities at *declaration time*. V1 adds
*enforcement time*: when a tool process is spawned, it actually cannot reach
the network, cannot read paths outside its declared mounts, cannot execute
arbitrary subprocesses.

The mechanism varies by platform:

- **macOS** — `sandbox-exec` with a generated `.sb` profile per tool, derived
  from the tool's declared capabilities.
- **Linux** — namespaces (mount, network, pid) plus Landlock for filesystem
  confinement.
- **Future** — containers (OrbStack, Apple Container) for stronger isolation
  when running untrusted skills.

The capability declarations from v0 (`[tool.capabilities] network = [...]`,
`filesystem = [...]`) become the input to enforcement. A tool that declares
`network = []` literally cannot open a socket. A tool that declares
`filesystem = ["./inputs"]` literally cannot read elsewhere.

V0 → V1 migration is a flag flip: same manifests, same declarations,
enforcement engaged.

### What this protects against

- Compromised or malicious skills exfiltrating data via undeclared network
  calls.
- Tools reading files they don't need (SSH keys, browser cookies, vault
  contents the tool wasn't granted).
- Tools spawning arbitrary subprocesses (e.g. `dlopen`-ing libraries that
  make HTTPS calls outside the declared allowlist).

### What this does NOT cover

- The parent Loom process itself, which holds the secrets vault and the
  model client. That's the trust root, not a sandbox target.
- Side-channel exfiltration (timing, resource usage). Out of scope for v1.

---

## 3. Long-running Loom as a daemon

V0 invokes Loom as a CLI for sub-agent calls — each `loom run` is a fresh
process. Cold start: parse manifest, load extensions, set up secrets.
Acceptable for compaction (rare); painful for hot-path sub-agent invocation.

V1 makes Loom a daemon. A single Loom process holds:

- The secrets vault (decrypted once).
- All loaded extensions (parsed manifests, instantiated harness/session
  classes).
- All running agents (their sessions, in-flight turns).
- A Unix socket for clients (CLI, tools, ACP clients).

Sub-agent invocation becomes:

```
tool subprocess
  → loom-invoke (shim, ~50 lines)
  → daemon socket
  → daemon spins up a sub-agent in-memory (no cold start)
  → result streams back
```

The CLI is preserved for one-shot use (`loom run ./agent.toml`), and
auto-detects a running daemon to join it.

### Properties this gives us

- **Performance.** Sub-agent calls in the millisecond range, not the
  hundred-millisecond range.
- **Statefulness across calls.** A long-running agent persists in the daemon
  between client invocations. A Discord listener can hand off to the same
  daemon-resident agent across messages without reloading.
- **Single secrets boundary.** One process reads the vault, ever. CLI and
  tool subprocesses never have direct vault access.

---

## 4. Registry and naming

V0 resolves extensions by bare-string name (against builtins) and dependencies
by path. V1 adds a registry layer that lets bare names point to *installed*
skills, tools, and agents — not just builtins.

### Local registry layout

```
~/.loom/
├── extensions/
│   ├── harness/
│   │   └── anthropic/        (a third-party harness installed locally)
│   └── session/
│       └── rlm/
├── skills/
│   ├── discord-dm/
│   └── memory/
├── tools/
│   ├── discord-send/
│   └── secrets-get/
└── agents/
    ├── compactor/            (an installed sub-agent reachable by bare name)
    └── morning-checkin/
```

`loom install <path-or-url>` symlinks or copies a manifest into the
appropriate directory. Manifests in any directory of `~/.loom` are
addressable by bare name from any `agent.toml`.

### Bare-name resolution becomes uniform

V0 syntax (path-based):

```toml
[skills]
discord-dm = "../skills/discord-dm"
```

V1 syntax (still path-based, but bare names resolve to registry):

```toml
[skills]
discord-dm = "discord-dm"             # resolves to ~/.loom/skills/discord-dm
memory     = "../skills/memory"       # local path still works
```

Same field. Resolver tries bare name → registry → local path. No syntax
change required for v0 manifests; they continue to resolve.

### Versioning

Optional pin via name:

```toml
discord-dm = "discord-dm@1.4"
```

Defers SemVer enforcement to the registry; v1 ships a string-equality match.

### Distribution

V1 ships local install only. Remote install (`loom install github:user/skill`)
builds on local install when the moment comes — the registry directory is
the substrate, install commands are sugar.

---

## 5. Network-located agents over ACP

ACP is already the wire format for the SDK. V1 makes ACP a first-class
transport for sub-agent references:

```toml
[skills.research.subagents]
search = "acp://192.168.1.5:8910/search"
```

The four resolution modes from §1d become five: name → path → inline → ACP
URL. The capability check still applies (parent's `[sandbox]` must permit
the named sub-agent), but the actual execution happens on a remote machine.

### Properties

- **Distributed sub-agent invocation.** Laptop's agent calls home server's
  agent calls phone's agent. Composition shape unchanged; transport changes.
- **Model account pooling.** A central machine holds the API keys; thin-client
  agents on other machines invoke sub-agents over ACP. One place to rotate
  keys, one place to budget spend.
- **Hybrid local/remote trees.** Local sub-agents for fast cheap reasoning;
  remote sub-agents for things that need GPUs, secrets, or specific data.

### What v1 doesn't ship

- Authentication for ACP URLs (token-or-mTLS pattern, deferred to v2).
- Bidirectional capability negotiation (the local agent declares its
  `[sandbox]` ceiling for the remote, but the remote decides whether to
  accept).
- Discovery / service registry. Endpoints are configured statically.

---

## Beyond v1: dreams the v1 primitives unlock

These are not committed roadmap, but they fall out of v1 + ACP + the registry
without new architecture:

- **An agent package manager.** `loom install anthropic/research-pro@1.4`.
  Distributed manifests over git or a registry.
- **Multi-agent "team" manifests.** A `team.toml` declaring a set of named
  members and their inter-call permissions. The whole thing audits as one
  unit.
- **Agents-as-MCP-servers.** Expose any Loom agent as an MCP server with
  one flag. Cursor / Claude Desktop / anything MCP can call Loom agents as
  tools. The composition goes both ways.
- **Self-extending agents.** A tool that registers a new sub-agent into its
  own scope at runtime — under the parent's `[sandbox]` ceiling, so
  escalation stays bounded.
- **Swarm patterns.** A root agent fans out to N parallel sub-agents on
  different machines, each working on a slice. Embarrassingly parallel
  reasoning becomes a deploy pattern, not a research curiosity.
- **The "thinking" sub-agent pattern.** A sub-agent with the same identity,
  no tools, big model, fresh context window, summoned for hard reasoning.
  "I need to actually think hard about this" becomes a tool call.

The thing tying all of these together: none requires new architecture.
They're permutations of manifest + name resolution + capability tree + ACP
transport. Once those four are solid, the rest is composition.

---

## Summary

V1 is the version of Loom that survives third-party skills, multi-machine
deployment, and performance-sensitive use. It does so by making three v0
declarations actually-enforced:

| Declaration | V0 status | V1 status |
|---|---|---|
| Tool `[tool.capabilities] network`/`filesystem` | Validated against parent ceiling | Enforced at process level |
| Skill `subagents` declarations | Reserved (parser accepts, runtime ignores) | Enforced via token/broker |
| Sub-agent ceiling | Computed but not validated | Computed and validated recursively |

And by making one v0 limitation go away: the cold-start cost of subprocess
Loom invocation, via the daemon transport.

Everything else — registry, network-located sub-agents, the dream-list — is
composition on top of those primitives.
