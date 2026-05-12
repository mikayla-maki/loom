# Implement the MCP Meta-Provider

A self-contained kickoff prompt. Pass this to a fresh session along
with the repo to do the work.

---

## Context

MCP (Model Context Protocol) is how most LLM tool ecosystems
distribute capabilities today. A host spawns an MCP server (an
npm package, a binary, an HTTP endpoint), discovers its tools at
runtime via `tools/list`, and exposes each tool to the LLM. Claude
Desktop, Cursor, Continue, and most other clients all consume tools
this way.

Loom should consume them too. Three design choices shape this work:

### 1. MCP ships as a built-in meta-provider

The MCP integration is **not** an external provider package. It's
a built-in Tools factory named `mcp-server`, registered alongside
`builtin` in the native provider registry. Users don't `npm install
loom-mcp-provider` — Loom knows MCP natively.

MCP servers themselves (e.g. `@modelcontextprotocol/server-filesystem`)
are *not* Loom providers — their `package.json` has no
`loom.provider` field, and they shouldn't need one. They're just
MCP-protocol servers. Loom's built-in `mcp-server` factory knows
how to spawn them, speak the protocol, and adapt the discovered
tools to Loom's `Tool` interface.

### 2. `[providers]` entries gain a configured-factory form

The v5 grammar already accepts a `provider` field plus arbitrary
config keys on `[harness]`, `[session]`, and every `[tools.X]`
entry. The factory named by `provider` receives the rest of the
table as its config. We're extending the same pattern to
`[providers].handle` entries:

```toml
# Today (and still works): bare SourceSpec
[providers]
local_provider = { path = "./my-loom-provider" }

# New: configured factory reference, same shape as `[tools.X]`
[providers]
fs_mcp = { provider = "mcp-server", npm = "@modelcontextprotocol/server-filesystem" }
linear = { provider = "mcp-server", command = "npx", args = ["@linear/mcp-server"] }
```

The `provider` field references a Tools factory (built-in or, in
future, source-loaded). Other keys are config for that factory's
`create()`. `[providers]` handles still get dedup’d the usual way
— two `[providers]` entries with the same `(factory, config)` share
one Tools instance.

This means the manifest grammar gains exactly **one small rule**:
lift the SourceSpec-only restriction on `[providers]` entries.
Everything else (the resolver's binding flow, dedup, audit
attribution) reuses existing machinery.

### 3. Static enumeration only — no runtime tool discovery

Every MCP tool the model can call must appear by name in `[tools]`.
No `[tools.*]` wildcard, no `listTools()` interface method, no
auto-import. The manifest IS the security review surface; if a
server could silently register tools the user never read, the user
wouldn't know what their agent can do.

Users with a 20-tool MCP server write 20 `[tools.X]` entries.
That's the cost. The benefit is each tool's exposure is explicit
and auditable. A separate CLI authoring aid (`loom mcp inspect`,
Chunk 5) makes the first cut cheap — it dumps a TOML snippet you
paste and prune — but the runtime never auto-imports.

### The big win: capability-based partial application

MCP tools often take several arguments — a
`read_document(doc_id, text)` style — where the user wants to fix
`doc_id` at agent-config time and only expose `text` to the model.
The natural place to express that fixed binding is `[capabilities]`,
which already carries per-tool configuration. We're extending the
capability semantics from "what the tool may do" (security) to
"what the tool may do AND with which fixed inputs" (security +
binding). Same field, same shape; richer interpretation.

This is what makes the MCP integration *more* than a thin shim. It
lets manifest-time configuration take real bites out of the
LLM-visible tool surface, both for security (the model can't be
tricked into reading the wrong doc_id) and for ergonomics (the
model sees a one-arg tool instead of a two-arg one whose first arg
is always the same value).

### After this lands

- Users write `[providers].fs_mcp = { provider = "mcp-server", npm = "..." }`
  and reference its tools from `[tools]`, one entry per MCP tool
  they want exposed.
- Per-tool `[capabilities]` entries can pre-fill or constrain
  individual MCP tool arguments. The model sees a tool whose schema
  has been narrowed accordingly.
- `loom audit` shows MCP-contributed tools with their (possibly
  narrowed) inputSchema and which arguments are pre-bound.
- `loom mcp inspect <provider>` prints a TOML snippet the user can
  paste-and-prune to bootstrap a manifest.
- The default chain still works; this is purely additive.

### Code state when you start

- The session-chaining + layered-sessions work is done. Sessions
  can own tools via `tools() + resolveTool()`.
- The notes example (`examples/loom-notes-provider/`) is the
  canonical model for a Tools contribution — read it as a
  reference shape, but note we're putting MCP in `src/builtins/`,
  not `examples/`.
- `src/builtins/provider/native.ts` is where built-in Tools live
  today (the `builtin` factory backing `bash`, `read_file`, etc.).
  The new `mcp-server` factory lives alongside it.
- `src/builtins/index.ts` registers built-in factories. `mcp-server`
  registers here.
- `src/manifest/parser.ts` (`parseProviderEntry`) restricts
  `[providers]` entries to SourceSpec-only today. **This restriction
  is what we're lifting.**
- `src/manifest/resolver.ts` (`resolveProvidersTable`,
  `resolveFactoryReference`) is where handle resolution happens.
  The new configured-factory form flows through this.
- `src/manifest/capabilities.ts` is where the capability grant
  semantics live (`assertRequires`, `assertKnownKinds`,
  `kindGranted`, `valueFor`). We'll add a new helper for
  argument-binding without changing the existing functions.
- `src/runtime/tool-table.ts` validates tool inputs against
  `inputSchema` via Ajv. MCP-narrowed schemas flow through this
  unchanged.
- **Plugin storage exists.** `FactoryContext.storage` is a string
  pointing at the agent's per-host storage directory (managed by
  Loom; see `internal-docs/plugin-storage-implementation-prompt.md`
  if not yet implemented — if it isn't, **land that first**, this
  work depends on it). The MCP factory uses `ctx.storage` for any
  on-disk state it needs (tool-list cache, server PID files, etc.)
  instead of inventing its own path scheme.
- 307 tests pass.

---

## Design background — MCP in 60 seconds

MCP is JSON-RPC over a transport (stdio for local servers, SSE/HTTP
for hosted). Servers expose three resource kinds; we only care about
**tools** for this work.

The protocol surface we need:

- **Initialize.** `initialize` request with protocol version +
  client capabilities → server returns its capabilities + info.
- **`tools/list`.** Returns `{ tools: [{ name, description,
  inputSchema, ... }] }`. Schema is JSON Schema, same shape Loom
  already uses.
- **`tools/call`.** Send `{ name, arguments }`, receive
  `{ content: [...], isError?: boolean }`. Content can be text,
  image, audio, or embedded resources; we'll start by surfacing
  only text and falling back to a JSON dump for other types.

The official SDK is **`@modelcontextprotocol/sdk`** (Node, TypeScript,
maintained). Use it. Don't hand-roll the protocol.

Transports we need:

- **stdio** — server is a local subprocess. Most npm-distributed
  MCP servers work this way. This is the priority.
- **SSE / HTTP** — hosted servers. Nice-to-have for v1; can defer.

---

## Implementation plan

Land each chunk in its own checkpoint. Run `npx tsc -p tsconfig.json
--noEmit` and `npm test` after each.

### Chunk 1: scaffolding

Lift the SourceSpec-only restriction on `[providers]` entries.
This is the one manifest-grammar change.

- **Types** (`src/types/manifest.ts`):
  - `ProviderEntry` gains a third shape: `{ provider: Reference,
    [configKey: string]: unknown }` — same shape as
    `HarnessSpec` / `SessionSpec` / `ToolEntryTable`. Keep the
    bare-string + SourceSpec-table shapes as-is.
- **Parser** (`src/manifest/parser.ts`):
  - `parseProviderEntry`: detect tables carrying a `provider` field;
    parse them via the same path `parseHarnessSpec` /
    `parseSessionSpec` / `parseToolEntry` already use. Validate
    `provider` as a `Reference`; treat the rest as config (carry
    through verbatim).
  - The existing SourceSpec-shape check on `parseProviderEntry`
    fires only when no `provider` field is present.
  - Update the error message and JSDoc to reflect the two shapes.
- **Resolver** (`src/manifest/resolver.ts`):
  - `resolveProvidersTable` today builds `providerSources: Map<handle,
    SourceSpec>`. Introduce a parallel `providerFactories: Map<handle,
    { factoryName: Reference, config: Record<string, unknown> }>` for
    the configured-factory form.
  - `resolveFactoryReference` (used by `[harness]` and `[session]`)
    already knows how to dereference a handle: it checks
    `providerSources` first. Extend it to check `providerFactories`
    too: if the handle resolves there, the factory name + config
    come straight from the configured-factory entry.
  - For `[tools.X].provider = "fs_mcp"`: the resolver looks up
    `fs_mcp` in `providerFactories`, finds `{ factoryName:
    "mcp-server", config: { npm: "..." } }`, and creates a
    provider instance with that factory + merged config
    (`config = { ...providerConfig, ...toolConfig }`).
  - Dedup key: `(factoryName, mergedConfig)`. Two `[providers]`
    handles pointing at the same `(mcp-server, { npm: "X" })`
    config still share one Tools instance.

**No new test fixture for the MCP factory yet** — we'll wire it up
in Chunk 2. For this chunk, write parser + resolver tests using a
fake factory name (`"test-meta"` or similar) to exercise the
plumbing without depending on real MCP infrastructure.

Verify with `npx tsc -p tsconfig.json --noEmit` + `npm test`.

### Chunk 2: stdio MCP factory — lifecycle

Add `@modelcontextprotocol/sdk` to the root `package.json`
(dependency, not devDependency). Verify it imports under the main
tsconfig.

Create `src/builtins/provider/mcp.ts` exporting a Tools factory
registered as `mcp-server`. Register it in `src/builtins/index.ts`
alongside the native provider.

The factory's `create(config, ctx, secrets)` needs to:

- Read config: `{ command?: string, args?: string[], npm?: string,
  env?: Record<string, string> }`. One of `command` or `npm` must be
  present:
  - `npm = "<pkg>"` shorthand: resolve to `command = "node"`,
    `args = ["<resolved-path-to-pkg-main>"]`. Use the existing
    provider-source resolution machinery if it fits, otherwise the
    simple `require.resolve()` shape.
  - `command = "<cli>"` + optional `args`: spawn that command
    directly. Useful for `npx`-based servers or non-Node binaries.
- Build the MCP `StdioClientTransport` from the SDK around the spawn.
- Construct an MCP client, `connect()` it, call `initialize`, and
  store the server's info (`name`, `version`, `capabilities`) on the
  Tools instance for audit.
- Use `ctx.storage` for any on-disk state. Recommended sub-layout
  (convention, not enforced): `<ctx.storage>/mcp/<provider-handle>/`
  for this server's stuff. PID files for graceful shutdown across
  crashes, cached `tools/list` results if you want to speed up
  boot, etc. Don't invent paths under `manifestDir` or `tmpdir()`
  — use the storage root.
- Return a `Tools` whose `init()`, `resolveTool()`, and `close()`
  are wired up. `close()` must close the transport and reap the
  child process. SIGTERM with a short grace period, then SIGKILL.

For this chunk, `resolveTool()` returns `null` for everything —
we'll wire it up in Chunk 3.

Verify: a manifest like

```toml
[providers]
fs_mcp = { provider = "mcp-server", npm = "@modelcontextprotocol/server-filesystem" }
```

…audits cleanly (the provider loads, the server spawns, no tools
resolve, the server shuts down on agent close). Run
`loom audit` against a fixture; verify no zombie processes via
`ps`.

### Chunk 3: tool resolution + execution

Inside the Tools `init()`:

1. Call `tools/list` on the MCP client.
2. Cache the result: `Map<string, McpTool>` keyed by name.
3. Each entry is `{ name, description, inputSchema, annotations? }`
   — the raw shape MCP gave us.

Then `resolveTool(name, config, agent, capabilities)`:

- Look up `name` in the cache (or `config.mcp_tool` if set — see
  rename below).
- If missing, return `null`. The model-facing name doesn't match
  any MCP tool the server offers; let the runtime's fallback chain
  take over.
- If present, return a Loom `Tool` whose `execute(input)` calls
  `tools/call({ name: <mcp_tool>, arguments: input })` and converts
  the response to `ToolResult`. Content conversion: text content
  → joined string; other content types → JSON-stringified.
  `isError: true` → `ToolResult` with `isError: true`.
- Forward the MCP tool's `description` and `inputSchema` verbatim
  to the Loom `Tool`. Schema narrowing comes in Chunk 4.

**Tool renaming via `mcp_tool`.** A `[tools.X]` entry pointing at an
MCP provider can carry a `mcp_tool` config key naming the
underlying MCP tool:

```toml
[tools.read_one_doc]
provider = "fs_mcp"
mcp_tool = "read_text_file"   # underlying MCP tool name
```

When `mcp_tool` is omitted, the manifest key IS the MCP tool name
(direct passthrough). When present, the manifest key is the
model-facing name and `mcp_tool` is the dispatch target. This lets
you expose the same MCP tool under multiple model-facing names
with different capability grants — essential for the partial-
application story in Chunk 4.

The `mcp_tool` field is provider-specific; the parser doesn't know
about it (it's just an extra config key on the `[tools.X]` entry).
The MCP factory's `resolveTool` reads it from `config`.

With Chunks 1–3 done, this manifest works end-to-end:

```toml
[providers]
fs_mcp = { provider = "mcp-server", npm = "@modelcontextprotocol/server-filesystem" }

[tools.read_text_file]
provider = "fs_mcp"

[tools.list_directory]
provider = "fs_mcp"

[capabilities]
read_text_file = "*"
list_directory = "*"
```

Note on the resolver flow: `Tools.resolveTool(name, ...)` returns
null for names the provider doesn't claim. The runtime doesn't
need to know up-front which names a provider serves — it just
asks at bind time. Tools contribution claims any name in this
model; the MCP factory uses its discovery cache to decide. **The
runtime doesn't need to discover at resolution time; discovery is
lazy.**

### Chunk 4: `loom mcp inspect` authoring aid

Static enumeration is the policy. But users need a way to *discover*
what an MCP server offers without writing 20 stub entries by hand.
The answer is a CLI command — not a runtime feature — that prints
a manifest snippet.

Add `loom mcp inspect <provider-spec>` to the CLI. Behaviour:

1. Take a provider spec on the command line: a path, an npm name,
   or a `[providers]` handle in a manifest passed via `--manifest`.
2. Spawn the MCP server, call `initialize` + `tools/list`, kill
   the server.
3. Print to stdout a TOML snippet:

   ```toml
   # Tools advertised by @modelcontextprotocol/server-filesystem
   # (filesystem 0.5.0). Review each entry, prune what you don't
   # want, and configure [capabilities] for what you keep.

   [tools.read_text_file]
   provider = "fs"
   # MCP schema: { path: string }

   [tools.write_file]
   provider = "fs"
   # MCP schema: { path: string, content: string }

   # ... etc

   [capabilities]
   # read_text_file = { path = "/path/to/somewhere" }   # pre-bind
   # write_file = { path = "*", content = "*" }         # unrestricted
   ```

4. Also accept `--json` for machine-readable output.

The user runs the command once, pipes/pastes the output into their
`agent.toml`, then prunes and configures. The runtime stays
static: only what's in `[tools]` gets exposed.

No changes to the `Tools` interface, no changes to the resolver,
no new manifest grammar. This chunk is purely additive CLI work.
Reuses the same MCP client plumbing from Chunks 2–3.

Open question: should `inspect` also probe `[capabilities]` shape
by reading the JSON Schema and suggesting plausible pre-bindings
(e.g., `string` args get `"*"`, `enum` args get the enum array)?
Probably yes — but as commented-out hints, never as defaults. The
user must uncomment each one to enable it.

Audit note: `[tools.X] mcp_tool = "Y"` is an optional config field
on a tool entry that renames the MCP tool. Example:

```toml
[tools.read_one_doc]
provider = "fs"
mcp_tool = "read_text_file"   # the underlying MCP tool name
```

When omitted, the manifest key IS the MCP tool name. When present,
it lets the user expose the same MCP tool under multiple
model-facing names with different capability grants — e.g.,
`read_one_doc` (pre-bound path) AND `read_text_file` (free path)
both back the same MCP `read_text_file`.

### Chunk 5: capability-based partial application

This is the load-bearing chunk for the design.

**The story:** a user writes

```toml
[capabilities]
read_document = { doc_id = "doc-123" }
```

The MCP `read_document` tool's MCP schema is:

```json
{
  "type": "object",
  "required": ["doc_id", "text"],
  "properties": {
    "doc_id": { "type": "string" },
    "text": { "type": "string" }
  }
}
```

After the capability is applied, the **Loom Tool's** `inputSchema`
the model sees is:

```json
{
  "type": "object",
  "required": ["text"],
  "properties": {
    "text": { "type": "string" }
  }
}
```

When the model calls `read_document({ text: "hi" })`, the provider's
`execute` merges the bound `doc_id` and calls MCP with
`{ doc_id: "doc-123", text: "hi" }`.

**Grant semantics for MCP-tool arguments:**

A capability grant is a map keyed by argument name. Each value
determines how that argument is handled at execute time:

| Grant value | Schema effect | Execute effect |
|---|---|---|
| `"<literal>"` (string/number/bool) | argument removed from `properties` and `required` | merged into MCP call |
| `["a", "b", "c"]` (array) | argument constrained via `enum: [...]` | passed through from model |
| `"*"` | argument unchanged in schema | passed through from model |
| absent | argument unchanged in schema | passed through from model |
| `{ default = "X" }` | argument made optional (removed from `required`); placeholder retained in `properties` | merged from model OR fallback to `"X"` |

(That last row is a stretch goal; for v1 we can ship just literal,
array, `"*"`, absent.)

The whole-tool grant `"*"` and `{}` still work: `"*"` means
"unrestricted, full schema, no binding"; `{}` means "no fields
granted, tool fails boot if it has required args."

**Implementation surface:**

A new function in `src/manifest/capabilities.ts` (or a new file
adjacent to it):

```ts
export interface AppliedGrant {
  /** Narrowed schema the model sees. */
  schema: JSONSchema;
  /** Fixed arg values to merge at execute time. */
  bound: Record<string, unknown>;
  /** Names the model is allowed to provide (after narrowing). */
  modelArgs: Set<string>;
}

export function applyArgGrant(
  schema: JSONSchema,
  grant: CapabilitySet,
): AppliedGrant;
```

The MCP provider's `resolveTool` calls `applyArgGrant(mcpSchema,
capabilities)` and uses the result to build the Loom Tool. The
Tool's `inputSchema` is `applied.schema`; `execute(input)` merges
`{ ...applied.bound, ...input }` before calling MCP.

(Validation: if `input` contains a key in `applied.bound`, that's
the model trying to override a fixed value — reject with a clear
`ToolInputError`.)

**Existing built-in tools shouldn't change.** `bash`'s `paths`,
`subprocess`, `network`, `env` aren't argument-shaped — they're
kind-shaped. The argument-binding extension applies when the
provider opts in via the new schema-narrowing helper. Native tools
keep their own `assertRequires` semantics.

This is an important point: **the capability grant gains a
shape-dependent interpretation.** For built-in tools, kinds match
the tool's declared `requires`. For MCP-style tools, kinds match
the tool's MCP argument names. The provider's `resolveTool`
decides which interpretation to apply by either calling the new
`applyArgGrant` helper or sticking with the kind-based shape it
already declares.

We're not changing the built-in shape. We're adding a new
provider-side helper for argument-binding-style providers.

### Chunk 6: secrets in MCP env

MCP servers often need secrets (API keys, tokens) via env vars.
The provider's config should accept a `secrets` field that maps
secret names to env-var names, e.g.:

```toml
[providers]
linear = { npm = "@modelcontextprotocol/server-linear" }

[tools.*]
provider = "linear"
secrets = { LINEAR_API_KEY = "LINEAR_API_KEY" }
```

The Tools `create()` already receives a `secrets: Record<string,
string>` (filtered by what the contribution registered as
`secrets.required` / `optional`). The provider passes those into
the spawned MCP server's env. Map `secrets[name]` → child process
env var.

Update the Tools contribution registration to declare which secrets
it expects. Since the provider doesn't know at registration time
which secrets the user will configure, the registration's
`secrets.optional` should be permissive (e.g. `["*"]` if we
support that, or a sentinel meaning "any secret named in instance
config"). Worst case: have providers declare specific secret names
they support.

### Chunk 7: audit + diagnostics

`loom audit` should show MCP-contributed tools cleanly. The audit
already calls `resolveTool` per binding; what we need to add:

- For tools backed by MCP, the audit summary should show:
  - The MCP server's name + version (from `initialize` response).
  - Each tool's narrowed schema (after `applyArgGrant`).
  - Which arguments are pre-bound (from `[capabilities]`).
- Wildcard expansion (`[tools.*]`) should be visible: each expanded
  tool's `introducedBy` shows the source.

If the MCP server fails to start (binary missing, init failed),
audit should record the error and show the (un-resolvable) tools
in `unresolvedTools` — same as it does for other provider load
failures today.

### Chunk 8: tests + docs

- The `mcp-server` factory builds cleanly and registers in
  `src/builtins/index.ts`.
- A test that boots an agent with a stub MCP server (in-process,
  no subprocess — the MCP SDK supports an in-memory transport for
  this) and verifies:
  - The factory spawns/connects cleanly.
  - Tools are discovered.
  - A tool with no capability grant works (full schema, no
    binding).
  - A tool with `[capabilities].X = { y = "literal" }` shows the
    narrowed schema to the model and merges the binding on
    execute.
  - `mcp_tool` rename works (manifest key differs from MCP name).
  - `[providers]` configured-factory form parses, resolves, and
    dedupes correctly.
  - Process cleanup on agent close: no zombie children.
- Add `examples/agent-with-mcp.toml` as a separate demo (keep
  the notes example clean). It should show: one `[providers]`
  entry, two or three `[tools.X]` entries, and at least one
  capability binding to demonstrate partial application.
- README updates: a new section on the MCP integration with the
  capability-binding story front and center. Mention that
  `mcp-server` is built-in (no separate install).
- `internal-docs/manifest-v5.md` should gain:
  - A note on the configured-factory form for `[providers]`
    entries (in §1 — the grammar table).
  - A section on the argument-binding capability semantics (next
    to or inside the `[capabilities]` section).
  - A mention of `mcp-server` in the built-in names list (§4).
- `loom mcp inspect` is documented in CLI reference.

---

## Working style

- **One chunk per response.** Stop after each with a status report.
- **Typecheck + tests must be clean** before moving on.
- **Use the official MCP SDK** (`@modelcontextprotocol/sdk`). Don't
  hand-roll JSON-RPC.
- **Process lifecycle is a real concern.** MCP servers are
  subprocesses. Test with a real one (`@modelcontextprotocol/server-filesystem`
  or `@modelcontextprotocol/server-memory` — both real, both
  npm-installable). Kill them on `Tools.close()`. Wire up SIGTERM
  on agent close.
- **The capability-binding extension is the load-bearing piece.**
  If chunk 5 is gnarlier than expected, pause and design before
  coding. Don't smuggle in special-cases.

---

## Things to deliberately NOT do

- **No dynamic tool discovery at runtime.** This is the load-bearing
  rule. The manifest IS the security review surface. Every tool the
  model can call must appear by name in `[tools]`. No `[tools.*]`
  wildcard, no `listTools()` interface method, no auto-import,
  nothing. Discovery happens at *authoring* time via
  `loom mcp inspect`; the runtime is static. If you're tempted to
  add a wildcard "for ergonomics," stop — the cost is the user no
  longer knows what their agent can do, which is the whole game.
- **No new top-level manifest section for MCP.** No `[mcp.servers]`
  block. MCP is a provider like any other; it goes in `[providers]`.
  The capability binding lives in `[capabilities]` like any other
  tool's grant.
- **No transport beyond stdio in v1.** SSE / HTTP MCP servers are
  a follow-up. Pick the dominant case first.
- **No tool-call streaming.** MCP supports progress notifications;
  Loom doesn't surface them today. The provider can ignore them
  for v1 (just await the final response).
- **No MCP resources or prompts.** MCP has three resource kinds;
  we're only doing tools. Resources (files, URIs) and prompts
  (template injection) are out of scope.
- **No retro-fitting argument-binding to built-in tools.** Bash's
  `paths` is *not* an argument. The argument-binding semantic is
  for provider tools that opt in via the new schema-narrowing
  helper. Don't change `assertRequires` or `kindGranted` for
  built-ins.
- **No MCP-server packaging.** Loom doesn't ship MCP servers; it
  consumes them. Users install the MCP server as a normal npm
  dependency and reference it in `[providers]`.

---

## Definition of done

- An end-to-end working example with explicit per-tool entries:

  ```toml
  [providers]
  fs_mcp = { provider="mcp-server", npm = "@modelcontextprotocol/server-filesystem" }

  [tools.read_text_file]
  provider = "fs_mcp"

  [tools.list_directory]
  provider = "fs_mcp"

  [capabilities]
  read_text_file = { path = "*" }
  list_directory = { path = "*" }
  ```

  …boots, exposes exactly the two named tools (no others from the
  server bleed in), and the model can call them.

- A capability-binding example works end-to-end:

  ```toml
  [tools.read_one_doc]
  provider = "fs"
  mcp_tool = "read_text_file"

  [capabilities]
  read_one_doc = { path = "/some/fixed/path.md" }
  ```

  …exposes a no-argument tool to the model that always reads the
  fixed path.

- `loom mcp inspect <provider>` produces a copy-paste-ready manifest
  snippet listing every tool the server advertises with commented
  capability hints.

- `loom audit` shows the MCP server and its narrowed tools cleanly.
- `npx tsc -p tsconfig.json --noEmit` returns 0 errors.
- `npm test` passes; new tests cover discovery, partial application,
  wildcard expansion, and process lifecycle.
- README + manifest-v5 docs updated.
- No zombie MCP server processes after `agent.close()`.

Good luck.
