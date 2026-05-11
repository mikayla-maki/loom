# Loom Manifest v4 — plugins, providers, tools as three layers

> Status: **historical**. Superseded by `manifest-v5.md`. Kept for
> reference; do not implement against this document.

## Motivation

v3 made `provider` the universal "where does this come from" key:
`[harness]`, `[session]`, and every `[tools]` entry name a provider,
and Loom auto-installs the underlying package. That model works
cleanly when each package contributes **one provider** — `@my-org/
loom-fetch` ships a provider that claims `fetch_url` and is done.

It breaks the moment a package wants to host **multiple configured
provider instances**. The canonical example is MCP: a single `loom-
mcp` package wraps the MCP wire format, but a real agent wants to
connect to several MCP servers — filesystem, github, postgres —
each with its own config, each contributing its own tools. In v3
those instances have nowhere to live; the package either has to (a)
fold all configs into one blob it parses internally, inventing a
sub-namespace per server, or (b) ship as many npm packages as
backends.

The clean fix is to name *instances*, not just types. Loom's three
real layers become first-class:

| Layer | Identity | What it owns | When you need one |
|---|---|---|---|
| **Plugin** | npm-shaped name + source | code; provider/harness/session *types* | once per code source |
| **Provider** | name in `[providers]` (or inline) | a configured *instance* of a provider type | once per backend you talk to |
| **Tool** | name in `[tools]` | model-facing verb + per-call grant | once per model-callable verb |

This document specifies the manifest grammar and runtime contract for
that three-layer model, and folds in the rename of `[extensions]` →
`[plugins]` we decided in parallel.

## Naming, settled

- `[extensions]` → **`[plugins]`** at the manifest layer.
- `loom.extension` (package.json field) → **`loom.plugin`**.
- `LoomExtensionApi` → **`LoomPluginApi`**.
- `src/extensions/` (third-party loader) → **`src/plugins/`**.
- `src/extensions/{harness,session,provider}/` (built-in factories) →
  stays put for now; orthogonal to this design. Disambiguating that
  directory is a separate cleanup.

The rest of this doc uses the new vocabulary throughout.

---

## 1. Manifest grammar

### 1.1 Principle: self-similar references, opt-in declaration

Wherever the manifest refers to **code on disk** — a plugin
(`[providers].<x>.plugin`), a tool provider (`[tools.<x>].provider`),
or a harness/session factory (`[harness].kind`, `[session].kind`) —
the value can be either:

- a **bare local name** that resolves to an entry in `[plugins]`,
  `[providers]`, or the appropriate built-in registry, *or*
- a **`SourceSpec`** (npm string, table, or path) that inlines the
  plugin source directly — Loom auto-installs.

The `provider` field on `[tools]` and the `kind` field on `[harness]`
/ `[session]` deliberately use different names — they refer to
different kinds of things. `provider` points at a *configured
instance* of a `Provider` (first-class, can be named in `[providers]`,
can host many tools). `kind` picks a *factory* off the harness or
session registry (closed; singleton per agent). Same grammar; different
semantics.

The `[plugins]` and `[providers]` tables are both **optional**. You
add them when you need what they offer: a reusable handle, a shared
provider instance, a non-default config, or a version pin. For
everything else, inline. The terse v3 shape is preserved unchanged.

### 1.2 The simple cases first

**Zero declarations** — one tool from one external plugin, no config
needed beyond what the plugin defaults to:

```toml
[agent]
name = "link-fetcher"

[harness]
kind = "anthropic"
model = "claude-sonnet-4"

[tools]
fetch_url = { provider = "@my-org/loom-fetch" }   # inline SourceSpec
```

**Provider needs config, used once** — still no `[plugins]` or
`[providers]` table. The plugin gets inlined; its config sits beside
the `provider` field:

```toml
[tools]
web_search = { provider = "@my-org/loom-search",
               apiKey = { secret = "SEARCH_KEY" } }
```

Keys other than `provider` flow to the provider's config schema. The
provider does the splitting (provider config vs. tool config) per its
own type definition — plugins document their key surface.

**Named, shared provider** — introduce `[providers]` only when you
want to *share* a configured instance across multiple tools, or give
it a documentation-friendly name:

```toml
[providers]
mcp = { plugin = "@my-org/loom-mcp", server = "stdio" }

[tools]
mcp_filesystem = { provider = "mcp" }
mcp_shell      = { provider = "mcp" }
```

Note `plugin` here takes an inline SourceSpec — no `[plugins]` table
needed. The plugin gets auto-installed; the provider is named.

**Plugin handle** — introduce `[plugins]` only when you want a
reusable local handle for a plugin you'll reference more than once,
or when you want a version pin:

```toml
[plugins]
mcp = { npm = "@my-org/loom-mcp", version = "^1.2" }

[providers]
fs-mcp = { plugin = "mcp", server = "filesystem" }
gh-mcp = { plugin = "mcp", server = "github" }
```

Here the `mcp` handle lets `[providers]` reference the plugin twice
without repeating the npm spec, and pins the version once.

### 1.3 The full shape (all three tables)

```toml
[agent]
name = "research-agent"
system_prompt = "./identity.md"

[plugins]
# Optional. Local handles for plugins you reference multiple times
# or want to version-pin. Value is a SourceSpec (string fast-path
# or table form).
mcp     = { npm = "@my-org/loom-mcp", version = "^1.0" }
discord = "@my-org/loom-discord"

[harness]
kind = "anthropic"                  # picks a harness factory by name
model = "claude-sonnet-4"

[session]
kind = "file"                       # picks a session factory by name
path = "./session.jsonl"

[providers]
# Optional. Named, configured provider instances. `plugin` is a
# bare handle (lookup in [plugins]) or an inline SourceSpec.
fs-mcp  = { plugin = "mcp", server = "filesystem", root = "./" }
gh-mcp  = { plugin = "mcp", server = "github" }
search  = { plugin = "@my-org/loom-search",          # inline SourceSpec
            apiKey = { secret = "SEARCH_KEY" } }

[tools]
# `provider` is a bare handle ([providers] or [plugins]) or an
# inline SourceSpec. See §1.4 for the full resolution order.
read_file       = {}                                              # builtin
write_file      = {}                                              # builtin
list_repos      = { provider = "gh-mcp" }                         # named provider
fetch_one_repo  = { provider = "fs-mcp", paths = ["./repos"] }    # named + per-tool config
web_search      = { provider = "search" }                         # named provider
"discord.send"  = { provider = "discord",                         # plugin handle (anonymous instance)
                    channels = ["#general"] }
fetch_url       = { provider = "@my-org/loom-fetch" }             # inline SourceSpec

[capabilities]
read_file = { paths = ["./"] }
write_file = { paths = ["./"] }
list_repos = "*"
fetch_one_repo = { paths = ["./repos"] }
web_search = "*"
"discord.send" = "*"
fetch_url = "*"
```

### 1.4 Reference resolution

A reference value (string or table) is classified by **shape first**,
then looked up:

- **String containing `/`, `@`, or starting with `./` / `../` / `/`** —
  treated as a SourceSpec string fast-path. Inline; auto-install.
- **Table with `npm`, `path`, or `git` key** — SourceSpec table.
  Inline; auto-install.
- **Bare string** (no `/`, `@`, `:`) — treated as a local handle and
  looked up in the table(s) appropriate to the field.

Field-specific lookup orders for the bare-handle case:

| Field | Lookup order on bare handle |
|---|---|
| `[plugins].<x>` (key only — always a name) | n/a |
| `[providers].<x>.plugin` | `[plugins].<handle>` → else parse error |
| `[tools.<x>].provider` | `[providers].<handle>` → `[plugins].<handle>` → builtin tool-provider name → else parse error |
| `[harness].kind` | built-in harness factory name → `[plugins].<handle>` (uses that plugin's harness factory) → else parse error |
| `[session].kind` | built-in session factory name → `[plugins].<handle>` (uses that plugin's session factory) → else parse error |

A handle that matches **both** a builtin and a `[providers]` /
`[plugins]` entry is a parse error ("ambiguous handle 'foo' — rename
the entry, or use the SourceSpec form to disambiguate"). We don't
pick a silent winner.

When a `[tools.<x>].provider` is a bare handle that resolves via
`[plugins]` (an anonymous instance), or is an inline SourceSpec, the
tool entry's other keys flow to the **provider** — the plugin's
provider type decides which keys it consumes versus which it passes
through as per-tool config. When `provider` resolves to a
`[providers]` entry, the tool entry's other keys flow to the **tool**
(the provider already has its config from the `[providers]` entry).

For `[harness].kind` and `[session].kind`, the entry's other keys
(e.g., `model`, `path`) are always factory config — there's no
second layer to split between.

### 1.5 Anonymous-instance dedup

When `[tools.<x>].provider` is a plugin handle or an inline
SourceSpec, Loom creates an anonymous provider instance. These
anonymous instances are cached by **(resolved plugin source,
config-shape hash)**:

- Two inline references to the same npm spec with the same config:
  one shared instance.
- Two references that resolve to the same `[plugins]` entry with
  the same config: one shared instance.
- A `[providers]` entry and an anonymous reference that happen to
  resolve to the same (plugin, config) pair: one shared instance.

Config-shape is computed by canonicalised JSON stringification
(sorted keys, normalised whitespace). The manifest's parsed form is
always JSON-shaped, so this is well-defined.

A manifest with twelve `[tools]` entries all referencing the same
MCP backend pays the cost of one `Provider` instantiation,
regardless of whether those references go through `[providers]`, a
`[plugins]` handle, or inline SourceSpec strings. Syntactic choices
stay ergonomic; the runtime stays cheap.

### 1.6 `[capabilities]` as a downward-propagating ceiling

`[capabilities]` and `[tools]` have different scoping rules across
the subagent tree, and v4 makes them explicit:

- **`[tools]` is local.** A manifest's tools are exposed to *that
  manifest's model* only. A subagent can have tools the parent
  doesn't, and vice versa. The parent's `[tools]` table is not a
  superset of any subagent's.
- **`[capabilities]` is a ceiling.** Every subagent's effective
  capability set must be a subset of its parent's. The check is
  recursive across the whole reachable subagent tree.

The practical implication: an entry in `[capabilities]` does **not**
require a matching entry in `[tools]` of the same manifest. A parent
that will spawn a subagent using `read_database` declares
`[capabilities].read_database = { db = "primary" }` even though it
has no `[tools].read_database` of its own — the grant is a permission
ceiling for descendants, not a wiring statement for this manifest.

Enforcement:

- **Runtime.** When a subagent is materialised, its computed
  capability set is checked against the parent's. A subset violation
  is a boot error in the subagent.
- **`loom audit`.** Walks the reachable subagent tree (inline or
  path-referenced manifests both) and reports any containment
  failure statically, before runtime sees the agent.

The rest of the capability machinery from v3 is unchanged — grants
are `"*"` / `{}` / per-kind tables, kinds are tool-defined, etc.
What v4 documents is the **subagent containment rule**, which has
always been the design intent and is now explicit.

---

## 2. Plugin API changes

### 2.1 The shift: providers stop being auto-active

In v3, a plugin's `register()` calls `api.addProvider(factory)` and
the runtime instantiates that provider once at boot. The plugin
implicitly *is* a provider.

In v4, a plugin registers **provider types** — factories the
manifest can instantiate by name (zero, one, or many times). The
plugin no longer assumes there's one of itself per agent.

### 2.2 Updated `LoomPluginApi`

```typescript
export interface LoomPluginApi {
  registerHarness(factory: HarnessFactory): void;
  registerSession(factory: SessionFactory): void;

  /**
   * Register a provider type. The manifest decides how many instances
   * to make (via [providers] entries or inline [tools] references) and
   * with what config. `factory` is called once per instance.
   *
   * `name` defaults to the plugin's package name when omitted, matching
   * the v3 "primary factory = package name" convention.
   */
  registerProviderType(typeDef: ProviderTypeDef): void;

  readonly pluginName: string;
  readonly agentName: string;
  readonly manifestDir: string;
  readonly loomVersion: string;
  /** Plugin-level config from [plugins].<name> in agent.toml. */
  readonly config: Record<string, unknown>;
}

export interface ProviderTypeDef {
  /** Defaults to the plugin's package name. */
  name?: string;
  /**
   * Optional JSON schema for per-instance config. Loom validates each
   * `[providers].<entry>` (minus `plugin`) and each inline reference
   * against this before calling the factory.
   */
  configSchema?: JsonSchema;
  /** Called once per instance the manifest asks for. */
  factory: (config: unknown, ctx: ProviderContext) => Provider | Promise<Provider>;
}
```

There is no `addProvider`. A plugin that wants "one configured
Provider per agent, no manifest configuration" expresses that
behaviour by:

1. Calling `registerProviderType({ name: <package-name>, factory })`.
2. Documenting that the user references the plugin name directly in
   `[tools]` entries: `provider = "@org/pkg"`. The runtime sees this
   as an inline provider reference with empty config, instantiates
   once via the type factory, and dedups across tools.

For 1:1 plugins (the common case), the user-facing manifest stays
as terse as the SourceSpec-inline form allows. The internal model
is that the provider is an *instance* of a registered type, not a
hard-wired singleton — so multi-instance plugins (MCP, anything
with a configurable backend) can use the same machinery.

### 2.3 What the rest of the SDK calls things

- `Plugin` — the loaded package (named, sourced, configured at
  `[plugins]` level if listed).
- `ProviderType` — a registered factory (a plugin can contribute
  many).
- `Provider` — an instance, configured per its `[providers]` entry or
  per its inline reference. Same `resolveTool` shape as v3.
- `Tool` — unchanged.

The `Provider` interface itself does not change. Only the *number of
instances Loom makes* and the *path by which it's instantiated*
change.

---

## 3. `loom install` — harvest from every reference site

Because SourceSpecs can appear in `[plugins]`, `[providers]`, or
`[tools]` (as inline references), the install harvest walks all
three:

1. Walk `[plugins]` entries → collect each SourceSpec value.
2. Walk `[providers].<x>.plugin` → collect SourceSpec values
   (skipping bare handles, which resolve to `[plugins]` and are
   already covered).
3. Walk `[tools.<x>].provider` → same.
4. Walk `[harness].kind`, `[session].kind` → same.

Dedup across (1–4) is by canonicalised SourceSpec — the same npm
spec referenced inline in three places installs once. A bare handle
that doesn't resolve anywhere is a parse error.

`lock.toml` records one entry per distinct SourceSpec. Plugins
declared in `[plugins]` appear under their local handle; plugins
referenced only inline appear under a synthetic handle derived from
the spec (e.g., `_anon_npm_my-org_loom-fetch`). The lockfile is the
source of truth for what actually got installed; the manifest is the
source of truth for what should be installed.

---

## 4. Implementation checklist

Neither v3 nor v4 has shipped — there are no manifests in the wild to
migrate. This is purely a checklist of what the implementation has
to build (or replace).

- **Manifest parser** — emit `[plugins]`, `[providers]`, `[tools]`
  tables with the shapes in §1. Reject the field names from earlier
  drafts (`[extensions]`, `[harness].provider`, `[session].provider`)
  cleanly; no back-compat shims.
- **package.json field** — plugins are detected by `loom.plugin`.
- **Plugin API** — the loader exposes `LoomPluginApi` with
  `registerHarness`, `registerSession`, and `registerProviderType`.
  No `addProvider`.
- **Resolution + dedup** — implement the shape-first classification
  in §1.4 and the anonymous-instance dedup in §1.5.
- **`loom install` harvest** — walk all four reference sites (§3);
  `lock.toml` records one entry per distinct SourceSpec.
- **Built-in factories** stay where they are; the rename of
  `src/extensions/` (third-party loader) to `src/plugins/` is a
  surface change with the same exports.
- **Test fixtures + samples** — update to the new shape in the same
  change.

### Worked example

A representative agent that uses two external plugins plus builtins:

```toml
[providers]
mcp = { plugin = "@my-org/mcp-pack", server = "stdio" }   # inline plugin

[harness]
kind = "anthropic"
model = "claude-sonnet-4"

[session]
kind = "compacting"
threshold = 50

[tools]
read_file      = {}
write_file     = {}
fetch_url      = { provider = "@my-org/loom-fetch" }   # inline; one tool only
mcp_filesystem = { provider = "mcp" }                  # named provider, two tools share
mcp_shell      = { provider = "mcp" }

[capabilities]
read_file = { paths = ["./"] }
write_file = { paths = ["./"] }
fetch_url = "*"
mcp_filesystem = "*"
mcp_shell = "*"
```

No `[plugins]` table — neither plugin needs a reusable handle.
`[providers]` exists only because `mcp` is shared by two tools.
Everything else stays inline. The reader sees:

- **`[providers]`** — the one shared, configured backend (`mcp`).
- **`[tools]`** — every model-facing verb. Three of them (`read_file`,
  `write_file`, `fetch_url`) are wired inline; two (`mcp_filesystem`,
  `mcp_shell`) reference the named provider.

If the agent grew to need a version pin on `loom-fetch`, you'd add a
minimal `[plugins]` table for that one entry; the rest of the
manifest wouldn't change.

---

## 5. Open questions

1. **`loom-mcp` doesn't exist yet.** The MCP integration is the
   driving use case but not in tree. Should we sketch its
   `ProviderType` shape in this doc, or wait until we implement
   it? *Recommend: sketch separately in `mcp-plugin.md`; this doc
   stays about the manifest contract.*

2. **Naming collisions across tables.** A `[plugins]` local name and
   a `[providers]` local name share the same lookup namespace from
   `[tools.X].provider`. We reject collisions at parse time (§1.4).
   Should we *also* reject when a plugin local name collides with a
   builtin tool/factory name? Probably yes — keeps the namespace
   flat. *Recommend: yes, with the same parse-error pattern.*

3. **Config validation timing.** `configSchema` runs at boot
   (before `register()`'s effects are visible). Should validation
   errors stop the boot or warn? *Recommend: stop. Bad config is
   a manifest bug.*

4. **Anonymous-provider dedup hash.** §1.5 dedupes by `(plugin,
   config-shape)`. Config-shape is a canonicalised JSON
   stringification. Risk: a plugin whose config contains live
   handles (e.g., a function callback from SDK use) won't hash
   stably. *Recommend: dedup only when the config is JSON-shaped.
   Anything non-JSON gets a fresh instance and a lint warning. The
   manifest-driven path is always JSON anyway.*

5. **Should `[harness]` and `[session]` ever support a `[providers]`-
   style table?** They're singletons per agent, so multi-instance
   has no use case. *Recommend: no. §1.4 already documents this —
   harness/session `provider` references skip the `[providers]`
   lookup step.*

6. **Built-in components directory rename.** `src/extensions/` still
   holds built-in harness/session implementations. Now that the
   third-party loader moves to `src/plugins/`, the built-in dir's
   name is even more confusing. Candidates: `src/builtins/`,
   `src/components/`, leave as-is. *Defer to a separate cleanup.*
