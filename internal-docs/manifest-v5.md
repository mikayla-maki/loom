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
| `[agent]` | yes | name, description, system prompt, secrets allowlist |
| `[providers]` | no | local handles for code sources (npm / path / git) |
| `[harness]` | yes | which harness this agent runs |
| `[session]` | no (defaults) | which session this agent uses |
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

`provider` is **required** on every `[tools.X]`, `[harness]`, and
`[session]` entry. For built-in tools use the string shorthand:
`bash = "builtin"` is sugar for `bash = { provider = "builtin" }`.
Empty `{}` is not accepted — every table form must name a provider.
A completely absent `[tools]` table still auto-loads the default
builtin set.

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

[session]
# Same rule. `file` is built in.
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

Built-in names today: `anthropic`, `openai`, `test`,
`small-model-of-parent` (harnesses); `memory`, `file`, `compacting`,
`fork-of-parent`, `skills` (sessions); `builtin` (the tool provider
that yields `bash`, `read_file`, `write_file`, `find`,
`spawn_subagent`).

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
