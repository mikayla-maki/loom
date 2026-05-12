# Loom Manifest v5 — one word, one table, one rule

> Status: design, awaiting implementation. This is the canonical
> design; manifest-v3.md and manifest-v4.md are historical drafts.
> Loom hasn't shipped — no migration story is needed for external
> users, only an in-tree implementation pass.

## Premise

Earlier drafts had too many concepts. v3 made `provider` a universal
"where does this come from" key, then v4 added a `[providers]` table
for named configured instances plus a `kind` field for harness/session
to disambiguate from the tools-layer `provider`. The result: five
manifest tables, two reference field names, three lookup orders,
a `ProviderType` abstraction the plugin author had to learn.

v5 collapses this to **one reference word, one declaration table,
one resolution rule, three matched register-X-returns-X methods**.

The user-facing vocabulary fits in a paragraph:

> A Loom agent is composed from **providers** — npm packages, local
> paths, or built-in code that contribute *harnesses*, *sessions*,
> and *tool providers*. The `[providers]` table optionally gives
> local handles to packages you reference more than once. Each of
> `[harness]`, `[session]`, and `[tools.X]` carries a `provider`
> field that names which provider supplies it. `[capabilities]` is
> the permission ceiling for this agent and any subagents it spawns.

That's the model. No "extension", no "ProviderType", no `kind`, no
"named provider instance vs. plugin handle". Four nouns
(`provider`, `harness`, `session`, `tool`); five tables; one verb
shape (`register<X>` returns an `X`).

---

## 1. Manifest grammar

### 1.1 Tables

| Table | Required? | Holds |
|---|---|---|
| `[agent]` | yes | name, description, system prompt, secrets allowlist, optional `storage_id` override |
| `[providers]` | no | local handles for code sources (npm / path / git) **or** for configured-factory aliases (e.g. MCP servers via the `mcp-server` built-in factory) |
| `[harness]` | yes | which harness this agent runs |
| `[session]` | no (defaults) | the agent's session: a singleton (`provider`) or a layered composition (`layers`) |
| `[tools]` | no (defaults) | model-facing verbs |
| `[capabilities]` | no | per-tool / per-subagent permission ceiling |

### 1.2 The `provider` field — one rule, used everywhere

Wherever code is referenced, the field is `provider`. Its value is one
of:

| Shape | Meaning | Resolved how |
|---|---|---|
| bare string (no `/`, no `@`, no `./`) | local handle or builtin name | `[providers].<handle>` first, then built-in registry |
| string with `/`, `@`, or `./` / `../` | inline `SourceSpec` (npm spec or local path) | auto-load |
| `{ npm = "...", version? = "..." }` | inline `SourceSpec` table | auto-load |
| `{ path = "...", subpath? = "..." }` | inline `SourceSpec` table | auto-load |
| `{ git = "...", rev? = "..." }` | inline `SourceSpec` table (future) | auto-load |

`[providers]` entries themselves accept **two** shapes:

- A bare `SourceSpec` (above table) — the historical form: the
  handle aliases a code source that the provider loader
  materialises at boot.
- A **configured-factory** form: `{ provider = "<factory>", ...config }`,
  same shape as `[harness]` / `[session]` / `[tools.X]`. The
  `provider` field names a Tools factory (built-in or, in future,
  source-loaded); the rest of the table is per-handle config that
  the runtime merges with use-site config when a downstream entry
  references the handle. This is what MCP servers use:
  `fs_mcp = { provider = "mcp-server", npm = "@…/server-filesystem" }`.
  See `mcp-server` in §4 for the built-in factory.

`provider` is **required** on every `[tools.X]`, `[harness]`, and
every `[session]` (singleton) or `[[session.layers]]` (layered) entry.
For built-in tools use the string shorthand: `bash = "builtin"` is
sugar for `bash = { provider = "builtin" }`. Inside `[session].layers`
the same string shorthand applies (a bare string entry expands to
`{ provider = "<string>" }`). Empty `{}` is not accepted — every
table form must name a provider. A completely absent `[tools]` table
still auto-loads the default builtin set. A completely absent
`[session]` block auto-loads the default chain `skills → compacting
→ memory`.

Resolution is field-agnostic except for the *built-in registry*
consulted: `[harness].provider` consults the harness registry,
`[session].provider` the session registry, `[tools.X].provider` the
tool-provider registry. Same rule, parameterized by slot.

### 1.3 Full shape

```toml
[agent]
name = "loom-demo"
system_prompt = "You are a helpful assistant."
secrets = ["ANTHROPIC_API_KEY"]            # optional allowlist

[providers]
# Optional. Local handles for packages you reference multiple times
# or want to version-pin. Value is a SourceSpec (string fast-path or
# table form). Skip this table entirely if every reference is inline.
mcp        = { npm = "@my-org/loom-mcp", version = "^1.2" }
loom-fetch = "@my-org/loom-fetch"
local      = { path = "../my-local-provider" }

[harness]
# `provider` references a built-in factory name OR a [providers] handle
# OR an inline SourceSpec. Anthropic is built in.
provider = "anthropic"
model = "claude-sonnet-4-5"
maxTokens = 4096

# Session is layered (outer-to-inner). Each `[[session.layers]]`
# entry is one layer. `compacting` is built in (a pull-side
# summariser); `file` is built in (JSONL on disk). See §1.7 for
# the layer protocol.
[[session.layers]]
provider = "compacting"
threshold = 60

[[session.layers]]
provider = "file"
path = "./session.jsonl"

[tools]
# Built-ins. The string shorthand is sugar for
# `{ provider = "builtin" }`.
bash       = "builtin"
read_file  = "builtin"
write_file = "builtin"
find       = "builtin"

# Plugin-backed tools. The runtime dedupes by (resolved source, config),
# so the next two tools share a single Tools instance:
list_files       = { provider = "mcp", server = "filesystem" }
read_file_remote = { provider = "mcp", server = "filesystem" }
# Different config → different instance:
list_repos       = { provider = "mcp", server = "github" }

# Inline SourceSpec — equivalent to declaring it in [providers] and
# referencing the handle. The runtime auto-loads it.
fetch_url = { provider = "@my-org/loom-fetch", apiKey = { secret = "FETCH_KEY" } }

[capabilities]
bash = { subprocess = "*", paths = ["./"] }
read_file = { paths = ["./"] }
write_file = { paths = ["./"] }
find = { paths = ["./"] }
list_files = "*"
read_file_remote = "*"
list_repos = "*"
fetch_url = "*"
```

### 1.4 Shape classification

A `provider` value (string or table) is classified by shape:

- Starts with `./` or `../` → SourceSpec path
- Starts with `/` → parse error (use the table form for absolute paths)
- Contains `/` → SourceSpec npm spec
- Contains `@` without `/` → parse error (scoped npm packages need a slash)
- Otherwise (bare string) → handle / builtin name
- Table → SourceSpec table (`{ npm: ... }` / `{ path: ... }` / `{ git: ... }`)

Same classification used at parse time everywhere. Resolution against
the appropriate registry happens later.

### 1.5 Anonymous-instance dedup

When a tool's `provider` resolves to an inline SourceSpec or a bare
handle pointing at `[providers]`, the runtime materialises a
`Tools` instance with the entry's non-`provider` keys as
config. Multiple tools with the same `(resolved source, config-shape)`
**share one instance**. This is what makes sharing implicit:

```toml
[tools]
# Both tools share one Tools instance with server="filesystem".
list_files    = { provider = "mcp", server = "filesystem" }
read_remote   = { provider = "mcp", server = "filesystem" }

# Different config → different instance.
list_repos    = { provider = "mcp", server = "github" }
```

Config-shape is computed by canonicalised JSON stringification
(sorted keys, normalised whitespace). The manifest's parsed form is
always JSON-shaped, so this is well-defined.

A manifest with twelve tools all pointing at one MCP backend pays
the cost of one `Tools` instantiation. Syntactic choices stay
ergonomic; the runtime stays cheap.

### 1.6 `[capabilities]` as a downward-propagating ceiling

Carried over from v4 §1.6 unchanged. Briefly:

- **`[tools]` is local.** A manifest's tools are exposed to *that
  manifest's model* only. Subagents have their own tool tables.
- **`[capabilities]` is a ceiling.** Every subagent's effective
  capability set must be a subset of its parent's. Recursive across
  the whole subagent tree. Enforced at runtime; surfaced statically
  by `loom audit`.

`[capabilities]` entries do **not** require matching local `[tools]` —
a parent grants `read_database = { db = "primary" }` so a subagent
spawned later can use it, even if the parent has no such tool itself.

#### Argument-binding interpretation (MCP-style tools)

For tools whose "kinds" are their input-schema argument names —
MCP-backed tools today, any provider-contributed tool that opts in
to the same model via `applyArgGrant` tomorrow — a per-arg grant
doubles as a *binding directive*. Same field, same shape; richer
interpretation. Schema effect / execute effect by grant value:

| Grant value                  | Schema effect                       | Execute effect              |
|------------------------------|-------------------------------------|-----------------------------|
| `"<literal>"` / number / bool | drop arg from properties + required | merge bound value into call |
| `["a", "b"]`                  | narrow property to `enum: [...]`    | passed through from model   |
| `"*"`                         | unchanged                           | passed through from model   |
| (arg absent in grant)         | unchanged                           | passed through from model   |

Whole-tool `"*"` keeps the full schema with no binding; `{}`
produces no binding and no narrowing — boot fails via
`assertRequires` when the tool has required args.

The model-visible `Tool.inputSchema` reflects the narrowing; the
provider merges the bound values back at execute time. If the
model tries to pass a value for a bound arg (e.g. by ignoring the
now-removed schema property), execute() rejects with `isError`
rather than silently letting the model overwrite a fixed binding.

This is what enables the "same MCP tool, multiple model-facing
names, each with a different binding" pattern — see `mcp_tool` in
§4's `mcp-server` description.

**Built-in tools are unchanged.** Bash's `paths` is *not* an
argument — it's a kind in the historical sense. The argument-
binding semantic is opt-in by providers via `applyArgGrant`. Native
tools keep their own `assertRequires` semantics.

### 1.7 Layered sessions — the universal composition shape

Every other field in the manifest resolves to a singleton (one
harness, one Tools instance per `(source, config)` tuple). Sessions
are different: the agent has one session, but that session may
itself be composed of N layers stacked outer-to-inner. The `[session]`
block describes either form:

- **Singleton.** `[session]` carries a `provider` key. That's the
  whole session — one factory.
- **Layered.** `[session]` carries a `layers` key whose value is an
  array of layer specs. Or equivalently `[[session.layers]]` as a
  TOML dotted-key array-of-tables. Outer-to-inner ordering.

#### The layer protocol

The `Session` interface's transport methods *are* the composition
protocol. Each layer is itself a `Session`; the composition is a
`Session`. Self-similar.

- **`push(event) → SessionUpdate[]`** flows **top-to-bottom**. Each
  layer receives the event, may transform / drop / fan it out, and
  returns what the next layer below should see. The bottom-most
  layer typically owns durable storage.
- **`pull(below) → SessionUpdate[]`** flows **bottom-to-top**. Each
  layer receives the events that the layers below it produced (the
  bottom layer's `below` is the caller's argument, usually `[]`)
  and may rewrite them before returning. What pops out at the top
  is the prompt the harness sees.

Everything else aggregates across all layers: `prepareTurn`,
`systemPromptSection`, `tools`, `trustedPaths`,
`dependencies.subagents`, and `close`. There is no "primary" layer
for these — each layer contributes, the runtime concatenates.

#### Manifest forms

```toml
# Singleton. One factory; the agent's whole session is this layer.
[session]
provider = "in-memory"
```

```toml
# Layered, dotted-key array-of-tables. Best when layers carry config.
[[session.layers]]
provider = "compacting"
threshold = 60

[[session.layers]]
provider = "in-memory"
```

```toml
# Layered, inline form. Best when no layer needs config.
[session]
layers = ["skills", "compacting", "in-memory"]
```

The inline form's array entries are either bare strings (sugar for
`{ provider = "<string>" }`) or inline tables. Note: `@iarna/toml`
implements TOML 0.5, which requires homogeneous arrays — mixed
string-and-table entries trip the parser. If any layer needs config,
use the `[[session.layers]]` dotted-key form for the whole chain.

The parser enforces these rules:
- `[session]` must carry exactly one of `provider` or `layers`.
- `layers` must be a non-empty array.
- The old top-level `[[session]]` form is rejected with a pointer at
  `[[session.layers]]`.

#### Default-when-absent

If the manifest declares no `[session]` block, the runtime applies
**`skills → compacting → in-memory`** as the implicit chain.
`skills` scans `~/.skills` (silently no-op when the directory is
missing), `compacting` bounds prompt growth, `in-memory` owns
volatile storage. Bounded growth and skill auto-loading out of the
box; users who want different policy write `[session]` explicitly.

Note: this is the agent's OS-level user home directory, not the
project directory. Auto-detecting `./skills/` (project-relative) is
deliberately not done — magic FS scans of the project surprise
people; reading from a known user-managed location does not.

#### SDK / pre-built instances

From the SDK, `AgentManifest.session` accepts three shapes:

1. A single `SessionSpec` (singleton).
2. A `SessionSpec[]` (layered).
3. A pre-built `Session` instance — used as-is, no resolution.
   This is the escape hatch for SDK consumers who want a direct
   reference to the layers (e.g. to wire `CompactingSession.compactNow()`
   to a `/compact` slash command). Construct it via
   `new ChainedSession([...])` if multiple layers are needed.

`ChainedSession` is not part of the public SDK surface — it's the
runtime's composition vehicle. Users compose via the manifest or
via pre-built layered instances.

---

## 2. Plugin contract

### 2.1 Package shape

A Loom provider is an npm-shaped package with `loom.provider` in its
`package.json` pointing at the registration entry:

```json
{
  "name": "@my-org/loom-mcp",
  "version": "1.2.0",
  "type": "module",
  "main": "./dist/index.js",
  "loom": {
    "provider": "./dist/index.js"
  }
}
```

### 2.2 Entry shape

The entry exports a `register(api)` function. Loom calls it once when
the manifest references this provider's source.

```ts
import type { LoomProviderApi } from "loom";

export function register(api: LoomProviderApi): void {
  // ... three optional contributions ...
}
```

### 2.3 Three registration methods

Each method's name matches the type it registers:

```ts
interface LoomProviderApi {
  registerTools(reg: ContributionRegistration<Tools>): void;
  registerHarness(reg: ContributionRegistration<Harness>): void;
  registerSession(reg: ContributionRegistration<Session>): void;

  /** This provider's handle from [providers], or its package name when referenced inline. */
  readonly providerName: string;
  readonly agentName: string;
  readonly manifestDir: string;
  readonly loomVersion: string;
}

interface ContributionRegistration<T> {
  /** Name the manifest references via `provider = "<this>"`. */
  readonly name: string;
  /** Secret names this contribution wants. Resolved before `create` runs. */
  readonly secrets?: SecretNeeds;
  /** Optional JSON schema for the contribution's per-instance config. */
  readonly configSchema?: JSONSchema;
  /** Sessions/harnesses that need a parent agent set this; ignored for tools. */
  readonly requiresParent?: boolean;
  /** Construct the contribution. Called once per instance the manifest asks for. */
  create(
    config: Record<string, unknown>,
    ctx: FactoryContext,
    secrets: Record<string, string>,
    parent?: Agent,
  ): T | Promise<T>;
}
```

The shape is uniform across all three methods. What differs is `T`
— the runtime interface specific to each contribution type.

### 2.4 Runtime interfaces

All three factory `create()` methods receive a `FactoryContext`:

```ts
interface FactoryContext {
  manifestDir: string;           // where agent.toml lives
  agentName: string;
  loomVersion: string;
  clientCapabilities: ClientAcpCapabilities;
  /**
   * Absolute path to a per-agent directory Loom guarantees exists.
   * One root per `[agent].storage_id` (defaulting to `[agent].name`).
   * Plugins put arbitrary state here — cached tool lists, journals,
   * notes files, PID files. No key-value abstraction; the path is
   * the entire surface. Convention (not enforced): namespace by
   * factory name to avoid colliding with siblings, e.g.
   * `<storage>/mcp/<handle>/cache.json` or
   * `<storage>/notes-provider/notes.md`.
   */
  storage: string;
}
```

The storage root is **lazy + side-effecting**: created on first
`runAgent` / `auditAgent` against a manifest, not at parse time. A
`.loom-agent` metadata file sits at the root recording which
manifest first created it; subsequent opens from a different
manifest path produce a non-fatal collision warning (visible in
`loom audit` output and `RunningAgent` boot logs).

```ts
interface Tools {
  /** Resolve a tool by name. Return null to decline (the runtime will surface as unresolved). */
  resolveTool(
    name: string,
    config: ToolConfig,
    agent: Agent,
    capabilities: CapabilitySet | undefined,
  ): Tool | null;
  /** One-shot init after construction, before serving any tools. */
  init?(args: InitArgs): Promise<void> | void;
  /** Cleanup on agent close. */
  close?(): Promise<void> | void;
}

interface Harness {
  run(runtime: Runtime, params?: RunParameters): Promise<TurnResult>;
  summarise?(args: SummariseArgs): Promise<string>;
  acpCapabilities?(): AcpCapabilityContribution;
}

interface Session {
  push?(event: SessionUpdate): Promise<SessionUpdate[]>;
  pull?(below: SessionUpdate[]): Promise<SessionUpdate[]>;
  // ... (full shape in src/types/interfaces.ts) ...
  close?(): Promise<void>;
}
```

### 2.5 Worked example

```ts
import type {
  LoomProviderApi,
  Tools,
  Harness,
  Session,
} from "loom";

export function register(api: LoomProviderApi): void {
  // Multi-instance: each (config) pair gets its own Tools.
  api.registerTools({
    name: "@my-org/loom-mcp",
    secrets: { required: ["MCP_TOKEN"] },
    async create(config, ctx, secrets): Promise<Tools> {
      const client = await connectMcp(config.server, secrets["MCP_TOKEN"]);
      return {
        resolveTool(name) {
          if (!client.hasTool(name)) return null;
          return proxyTool(client, name);
        },
        async close() { await client.disconnect(); },
      };
    },
  });

  // Singleton: one harness per agent. Same registration shape.
  api.registerHarness({
    name: "@my-org/loom-mcp",
    create(config, ctx, secrets): Harness {
      return new McpHarness(config, secrets);
    },
  });

  // Singleton: one session per agent.
  api.registerSession({
    name: "@my-org/loom-mcp",
    create(config, ctx, secrets): Session {
      return new McpSession(config.channel, secrets);
    },
  });
}
```

### 2.6 Convention: primary contribution name = package name

A provider's *primary* contribution of each kind is registered under
its package name. That's what makes `provider = "<plugin-handle>"`
work without the plugin author knowing what handle the manifest used:
the runtime falls back to the package name when the handle lookup
misses. If a single provider contributes multiple Tools instances /
harnesses / sessions of the same kind, secondary ones use any name —
the manifest then references them via inline SourceSpec or with
disambiguation syntax (TBD; see Open Questions).

---

## 3. Resolution at boot

The runtime walks the manifest, builds an internal IR, and instantiates
contributions. The pipeline:

1. **Parse manifest** → `AgentManifest`.
2. **Resolve manifest** → `ResolvedManifest` (binds each `provider`
   reference to a `(handle | source, slot, config)` triple; computes
   anonymous-instance dedup).
3. **Load providers** — for each distinct `SourceSpec`, run the
   provider's `register()` and collect its registered contributions.
4. **Phase-1 secrets** — resolve secrets the harness, session, and any
   referenced Tools declared.
5. **Instantiate harness** — look up its factory (with package-name
   fallback) and `create()`.
6. **Instantiate session** — same.
7. **Materialise Tools instances** — for each resolved instance, call
   the Tools type's `create(config, ctx, secrets)`; call
   `init()` after all are constructed.
8. **Phase-2 secrets** — resolve per-tool secret needs declared by
   resolved Tools.
9. **Validate capabilities + secrets allowlist** — runtime guards.
10. **ToolTable + RunningAgent** — wire up the dispatch.

`auditAgent` walks the same pipeline through step 7, then stops short
of init and produces a `CapabilityTree` rather than a `RunningAgent`.
Both audit and runtime share helpers via `runtime/boot.ts`; the only
difference is policy (audit catches errors and records them; runtime
throws).

---

## 4. Built-in providers

The runtime registers built-in harnesses, sessions, and tool providers
internally through the same `registerHarness` / `registerSession` /
`registerTools` machinery. There's no special-case code path
for built-ins; they're registered eagerly before any agent boots.

Built-in names today:

- **Harnesses:** `anthropic`, `openai`, `test`,
  `small-model-of-parent`.
- **Sessions:** `in-memory`, `file`, `compacting`, `fork-of-parent`,
  `skills`.
- **Tools provider:** `builtin` (yields `bash`, `read_file`,
  `write_file`, `find`, `spawn_subagent`).
- **Tools meta-factories:** `mcp-server` (registered in the Tools
  meta-factory registry; used via the configured-factory form of
  `[providers]`, e.g. `fs = { provider = "mcp-server", npm = "..." }`).
  Spawns the named MCP server, drives the `initialize` + `tools/list`
  handshake, and adapts each MCP tool to Loom's `Tool` interface.
  Lifecycle (close on agent shutdown), per-instance secret injection
  into the child env, and the `mcp_tool` rename + capability-based
  argument binding (§1.6+) are all handled inside the factory.

A manifest references a built-in identically to a plugin:

```toml
[harness]
provider = "anthropic"        # built-in

[session]
provider = "file"             # built-in

[tools]
bash = {}                     # tool key matches a built-in; provider defaults to "builtin"
read_file = { provider = "builtin", paths = ["./"] }   # explicit form
```

The `mcp-server` Tools meta-factory lives in its own registry (one
step up from the Tools-from-source loader) so it can be looked up
by name without going through `package.json`. A manifest plugs in
any MCP server via the configured-factory `[providers]` form:

```toml
[providers]
fs = { provider = "mcp-server", npm = "@modelcontextprotocol/server-filesystem" }

[tools.read_text_file]
provider = "fs"

[tools.read_welcome]
provider = "fs"
mcp_tool = "read_text_file"          # rename: same MCP tool, new model-facing name

[capabilities]
read_text_file = { path = "*" }
read_welcome   = { path = "/welcome.md" }   # pre-bind → zero-arg tool
```

Per-tool `secrets = { LOOM_NAME = "ENV_VAR" }` config injects
Loom-store secrets into the child process's env at spawn time.

The unification means **plugins and builtins are conceptually
identical**. The only difference is *where the code lives* — built-in
code is bundled with Loom; plugin code is in an npm package. The
manifest user doesn't need to know the difference.

---

## 5. Vocabulary reference

| Layer | Term |
|---|---|
| The package contributing code | "a Loom provider" (informal) |
| `package.json` field | `loom.provider` |
| Manifest table holding handles | `[providers]` |
| Manifest reference field | `provider` |
| Plugin entry function | `register(api)` |
| API the entry sees | `LoomProviderApi` |
| Registration methods | `registerTools` / `registerHarness` / `registerSession` |
| Registration record (generic) | `ContributionRegistration<T>` |
| Runtime contribution types | `Tools` / `Harness` / `Session` |
| Per-call context for `create` | `FactoryContext` |
| The tool-resolving instance | `Tools` |
| The individual tool a `Tools.resolveTool(name)` returns | `Tool` |

"Provider" is the package-and-manifest-layer word. "Tools" is
the runtime-class word. They don't overlap in any single sentence
because each only appears at its own layer in docs and code.

---

## 6. Migration from v4

For our own implementation reference; no external users to migrate.

| v4 | v5 |
|---|---|
| `[plugins]` table | `[providers]` table |
| `[providers]` table (configured instances) | **removed**; anonymous dedup carries it |
| `[harness].kind` / `[session].kind` | `[harness].provider` / `[session].provider` |
| `[tools.X].provider` (named handle or inline) | `[tools.X].provider` (one rule: handle-or-source) |
| `kind` (factory selector, harness/session) | unified under `provider` everywhere |
| `loom.plugin` package.json field | `loom.provider` |
| `LoomPluginApi` | `LoomProviderApi` |
| `registerProviderType` | `registerTools` |
| `Provider` (runtime tool router) | `Tools` |
| `ProviderType` (factory shape) | merged into `ContributionRegistration<Tools>` |
| `api.registerProviderType({ name, create(config) })` | `api.registerTools({ name, create(config, ctx, secrets, parent?) })` — same args as harness/session |
| Plugin loader at `src/plugins/loader.ts` | Same file, renamed exports |
| `src/runtime/boot.ts` shared helpers | Carry over unchanged; rename `materialisePluginProvider` → `materialiseTools` |

Behavioural changes: zero. Every v4 manifest can be mechanically
translated by find-and-replace.

---

## 7. Open questions

1. **Sub-factory disambiguation.** If a provider registers multiple
   Tools instances / harnesses / sessions of the same kind under
   different names, how does the manifest reference a non-primary
   one? Options: `provider = "@org/pkg:secondary-name"` (the v3
   syntax) or `provider = { source = "@org/pkg", name = "secondary" }`
   (table form). **Recommend**: defer until a real use case appears;
   the convention "primary = package name" covers the 95% case.

2. **`configSchema` validation timing.** v4 §5.3: hard-fail on
   schema mismatch at boot. **Recommend**: same.

3. **Anonymous-instance dedup hash for non-JSON config.** Manifests
   are always JSON-shaped after parsing, so this only matters for
   SDK-direct callers passing non-JSON-shaped config (functions,
   class instances). **Recommend**: dedup only when config is
   JSON-shaped; non-JSON gets a fresh instance and a lint warning.

4. **Internal Provider class rename.** v4's `Provider` becomes
   `Tools`. Do we keep a deprecated alias for one release?
   **Recommend**: hard-cut, nothing's shipped.

5. **`loom.plugin` field back-compat.** Old package.json files that
   we ourselves wrote in earlier example iterations have
   `loom.plugin`. **Recommend**: hard-cut; rename in tree.

6. **`loom plugins` CLI subcommand.** Rename to `loom providers`?
   **Recommend**: yes, for consistency with the vocabulary.

---

## 8. Implementation checklist

When we land this:

- **Parser**: `[plugins]` keyword → `[providers]`; reject v4 `[providers]` table (configured-instance form) with a pointed error; rename `kind` → `provider` in harness/session specs.
- **Resolver**: drop the named-provider-vs-plugin-anonymous fork; one resolution rule for `provider` regardless of slot; keep the SourceSpec shape classification; keep anonymous-instance dedup.
- **Plugin loader** (`src/providers/loader.ts`): rename file + types + `loom.provider` field detection. `LoomProviderApi` with `registerTools` / `registerHarness` / `registerSession`. Old `registerProviderType` is gone (no shim).
- **Built-in registrations**: refactor so the native Tools and built-in harness/session factories register through the same machinery as plugins (rather than separate global registries).
- **Runtime** (`src/sdk/run-agent.ts`): rename `Provider` → `Tools` everywhere; `materialiseTools` → `materialiseTools`; pass `(ctx, secrets, parent?)` to the Tools's `create` (new args the v4 shape didn't have).
- **Audit** (`src/audit/audit.ts`): same rename pass; the `plugins:` section in output becomes `providers:`; per-tool `via plugin 'X'` → `via provider 'X'`.
- **CLI** (`src/cli/main.ts`): `loom plugins` → `loom providers`; help text reflects the new vocabulary.
- **Example plugin**: rename `examples/loom-demo-plugin/` → `examples/loom-demo-provider/` (or leave the dir name and just update internals); update `index.ts` to use `LoomProviderApi` and `registerTools`; rebuild.
- **Sample manifest**: `examples/minimal-agent.toml` updated to v5 grammar.
- **Tests + fixtures**: bulk rename `kind:` → `provider:` (on harness/session), `[plugins]` → `[providers]`, drop the v4 `[providers]` table where it appears, `registerProviderType` → `registerTools`.
- **README + internal-docs**: update to v5 vocabulary. Mark v3 and v4 docs as historical.
