# Loom Manifest v3 — `provider` field unification + `loom install`

> Status: **historical**. Superseded by `manifest-v5.md`. Kept for
> reference; do not implement against this document.

This document specifies the v3 reshape of the agent manifest and the
`loom install` flow that materialises its dependencies. It supersedes
the `[extensions]` table from v2 and unifies the way Loom locates code
across harnesses, sessions, and tools.

The motivation, in one sentence: **a manifest is a dependency list,
and the dependency list should not be in two places.** Today's v2
shape forces the user to list each npm package once under
`[extensions]` and again in a `[harness]` / `[session]` / `[tools]`
entry that references the package's registered factory by name —
keeping the two in sync by convention. v3 makes the reference in
`[harness]` / `[session]` / `[tools]` the canonical place a package is
named; the runtime loads what it needs from there.

A second motivation, surfaced in discussion: **per-tool provider
routing.** v2 routes every tool name through a global chain of
providers ("ask each in order, first non-null wins"). v3 lets each
`[tools]` entry name *its* provider explicitly. This dedupes the
common MCP-style case (one package contributes a dozen tools) and
removes the silent name-claiming hazard.

---

## 1. The `provider` field — unified grammar

`provider` is the universal "where does this come from" key. It lives
in `[harness]`, `[session]`, and inside each `[tools].<key>` entry.
Same grammar in all three places.

### 1.1 String fast-path

```toml
[harness]
provider = "anthropic"                            # built-in

[session]
provider = "@my-org/loom-skills"                  # npm-shaped → auto-load

[tools.bash]
provider = "builtin"                              # default if omitted

[tools.shell_exec]
provider = "@my-org/mcp-pack"                     # routed to that package
```

Resolution rule (a single function over the string):

| Input shape | Meaning |
|---|---|
| `"builtin"` or absent | Built-in factory / native provider |
| Bare name (no `/`, no `@`, no `:`) | Built-in factory under that name |
| `"@scope/pkg"` | npm package; auto-loaded |
| `"@scope/pkg:factory"` | npm package; specific sub-factory inside it |
| `"./local-path"`, `"../sibling"` | Local-path source (auto-loaded) |
| `"name"` containing `:` but no slash | Reserved for future use; rejected at parse time |

Bare names and `"builtin"` are equivalent — they both look up the name
in Loom's registry of bundled factories. The string form covers
everything that doesn't need a version pin, a separate source spec, or
a local rename.

### 1.2 Table form (renames and explicit sources)

```toml
[session]
provider = { name = "skills", source = { npm = "@my-org/loom-skills", version = "^1.0" } }
roots = ["~/.skills"]

[tools.my_grep]
provider = { name = "grep", source = { path = "../my-fast-grep" } }
flags = ["-i"]                          # tool config sits alongside
```

Reserved keys inside the `provider = { ... }` table:

| Key | Type | Meaning |
|---|---|---|
| `name` | `string` (optional) | Factory name *inside* the resolved package. If omitted, defaults to the package's primary factory (registered under the package name by convention — see §2.3). For built-ins, defaults to the key itself in `[tools]`. |
| `source` | `string \| SourceSpec` (optional) | Where to fetch the code. Defaults to `"builtin"`. |

Everything else in the table is rejected at parse time — config goes
*outside* the `provider` table, as a sibling key in `[session]` /
`[tools.<key>]` etc. This keeps the boundary between "resolution
metadata" and "factory config" sharp.

The string fast-path is exactly the table form with `name` defaulted
and `source` inferred from the string: `provider = "@org/pkg"` is
shorthand for `provider = { source = { npm = "@org/pkg" } }`. The
table form is escape-hatch ergonomics — only needed for renames or
version pins.

### 1.3 `SourceSpec` shapes

```toml
source = "builtin"                                # bundled with loom
source = { npm = "@my-org/loom-skills" }
source = { npm = "@my-org/loom-skills", version = "^1.0" }
source = { path = "../my-local-pkg" }
source = { path = "./pkgs/skills", subpath = "./dist" }   # optional entry override
# future:
source = { git = "https://github.com/x/y", rev = "abc123" }
```

Discriminated by which key is present (`npm`, `path`, `git`,
`"builtin"`). Exactly one source key allowed; multiple is a parse
error.

`path` is resolved against the manifest's directory. Relative
`path = "../foo"` means a sibling of `agent.toml`, which is what makes
co-located development practical.

`version` for `npm` is an npm-compatible semver range; it's recorded
in the generated `package.json` (see §3.1) and locked in `lock.toml`
(§3.3).

---

## 2. Per-package provider routing

### 2.1 The change

In v2, all providers form a chain. When resolving a tool name, Loom
walks the chain — SDK providers, then extension providers, then
native — and uses the first one that returns a non-null `Tool`.

In v3, **each `[tools]` entry routes through *its declared
provider*.** A tool with `provider = "@org/mcp"` is resolved
exclusively by `@org/mcp`'s `Provider`. A tool with `provider =
"builtin"` (the default) is resolved exclusively by the native
provider. No silent claims; no global fan-out.

### 2.2 Why this is the right move

Three properties:

1. **Dedup is automatic.** A manifest with twelve `[tools]` entries
   all pointing at `provider = "@org/mcp"` loads `@org/mcp` exactly
   once and reuses the same `Provider` instance for each resolution.
   The user's redundancy concern is dissolved by routing, not by
   syntax.
2. **No accidental name-claiming.** A future MCP package whose
   `Provider.resolveTool("bash", …)` returns a non-null result cannot
   shadow a built-in `bash` unless the user explicitly routes a
   `[tools.bash]` entry through it. The trust direction stays
   explicit.
3. **Clearer errors.** Today's "no provider claimed 'X'" becomes
   "package '@org/mcp' did not claim tool 'X' (its `resolveTool`
   returned null)." Boot errors point at the package the user asked
   about.

The cost is the loss of the "global fall-through" behaviour, which in
v2 lets an extension transparently extend the agent. We argue this
behaviour was a footgun in disguise — visible only via `loom audit`,
and only by careful reading of which provider claimed what — and not
worth keeping.

### 2.3 Convention: package primary factory name = package name

When a `provider` string resolves to a package (npm or path), Loom
loads it and then looks up a factory by name. The convention is:

- A package registers its **primary** harness factory / session
  factory / tool provider under the package's own name. So `import
  pkg from "@my-org/loom-skills"` registers a session factory with
  `factory.name === "@my-org/loom-skills"`.
- Secondary factories use a `:`-suffix: `"@my-org/loom-pack:memory"`,
  `"@my-org/loom-pack:skills"`.

This makes `provider = "@my-org/loom-skills"` work without the user
having to know what string the package picked internally — the
registered name *is* the package name. Authors who want a shorter
local alias use the table form: `provider = { name = "skills", source
= { npm = "@my-org/loom-skills" } }`.

### 2.4 Tool key uniqueness

Tool keys (the model-facing names) remain globally unique across the
agent. If two packages both want to expose a tool called
`read_file`, the user picks one or aliases:

```toml
[tools.read_file]
provider = "@org/native-fs"

[tools.mcp_read]
provider = { name = "read_file", source = { npm = "@other/mcp-pack" } }
```

The model now sees both as `read_file` and `mcp_read`. Capabilities
are keyed by the same name (`[capabilities.read_file]`,
`[capabilities.mcp_read]`) — nothing changes there.

---

## 3. `loom install`

### 3.1 What it does

`loom install [--manifest agent.toml]` walks the manifest, collects
every distinct non-builtin `source`, and materialises each one to a
location Loom can `import()` at runtime.

```
loom install
  1. parse manifest, harvest sources:
       - npm:  collect {name, version} pairs
       - path: validate the directory exists and has a
               package.json with `loom.extension`
       - git:  (future) clone into the cache
  2. for npm sources:
       a. write <manifest-dir>/.loom/package.json with the harvested
          deps as a flat dependencies map
       b. exec `npm install --no-save --no-package-lock` (or similar
          — see §3.2) inside <manifest-dir>/.loom/
       c. resulting node_modules lives at
          <manifest-dir>/.loom/node_modules/
  3. for path sources: no-op (the dir is already there)
  4. write <manifest-dir>/.loom/lock.toml mapping each source spec
     to its resolved on-disk location plus the installed version
     (for npm)
```

### 3.2 npm choreography

The internal `package.json` Loom generates is invisible to the user
and has a fixed minimal shape:

```json
{
  "name": "loom-deps-<agent-name>",
  "version": "0.0.0",
  "private": true,
  "dependencies": {
    "@my-org/loom-skills": "^1.0",
    "@my-org/mcp-pack": "*"
  }
}
```

Loom shells out to `npm install` (with `--no-package-lock --no-save`
to keep the file shape predictable; we own the lockfile). We do NOT
generate `package-lock.json` — Loom's `.loom/lock.toml` is the
canonical lockfile and pins the resolved versions.

A `loom install --frozen` mode uses the existing `lock.toml` to set
exact versions (`"@my-org/loom-skills": "1.2.3"`) and re-runs `npm
install`, so a CI run gets the exact same tree.

### 3.3 `lock.toml`

A flat record of each source the manifest references and what was on
disk after the last successful install. The format:

```toml
# .loom/lock.toml
loom_version = "0.2.0"
manifest_hash = "sha256:..."           # manifest contents at install time
generated_at = "2024-03-15T14:22:00Z"

[[source]]
spec = "npm:@my-org/loom-skills@^1.0"
resolved = "1.2.3"
location = ".loom/node_modules/@my-org/loom-skills"

[[source]]
spec = "npm:@my-org/mcp-pack@*"
resolved = "0.4.1"
location = ".loom/node_modules/@my-org/mcp-pack"

[[source]]
spec = "path:../my-fast-grep"
location = "../my-fast-grep"
```

`loom run` reads this file at boot, validates each entry's `location`
exists, and adds those paths to the extension search chain ahead of
the default chain (`<manifestDir>/node_modules`, npm global,
`~/.loom/extensions`). If `lock.toml` is missing or its
`manifest_hash` doesn't match the current manifest, `loom run` errors
out with "run `loom install` first" (or, with `--install`, auto-runs
install before continuing).

### 3.4 On-disk layout

```
my-agent/
├── agent.toml
├── identity.md
├── .loom/                          # generated; .gitignore? user's call
│   ├── lock.toml                   # canonical, checked-in for reproducibility
│   ├── package.json                # generated; should be in .gitignore
│   └── node_modules/               # generated; .gitignore
│       ├── @my-org/
│       │   ├── loom-skills/
│       │   └── mcp-pack/
│       └── ...
└── ...
```

`lock.toml` is the only file in `.loom/` worth checking into git. We
ship a tiny `.gitignore` template you can drop into `.loom/` to that
effect:

```
# .loom/.gitignore (generated by loom install)
node_modules/
package.json
```

### 3.5 Caching across agents

Out of scope for v3. Each agent has its own `.loom/node_modules`; we
don't try to share across manifests via a global cache. If this
becomes a real pain point, a `--cache-dir ~/.loom/shared-cache` flag
is a small addition.

---

## 4. Removal of `[extensions]`

The `[extensions]` table is deleted from the v3 grammar. Its two v2
roles are subsumed:

| v2 role | v3 mechanism |
|---|---|
| Eager-load an npm package | Auto-loaded when a `provider` field references it |
| Pass per-package config | Each factory carries its own config in its own block (`[session]`, `[harness]`, `[tools.<key>]`) |
| Add a `Provider` claiming many tool names | Each tool routes through that package's provider via `provider = "@org/pkg"` |

A package that wants to contribute a tool provider must now be named
by every `[tools]` entry it claims. This is explicit; it removes the
"install a package and tools you didn't ask for appear" footgun.

The `[extensions]` parser, the `manifest.extensions` field on
`AgentManifest`, and the `collectExtensionFactories` flow in
`runAgent` all go away.

---

## 5. Migration: clean break

Loom is at 0.1.0; the only consumer of v2 manifests today is the
project's own tests and fixtures, plus the sample CLI. We take a
clean break:

- Parser accepts v3 only. A `[extensions]` table at the top level is a
  parse error with a pointed message ("v3 removes [extensions]; move
  the package reference into the relevant [tools]/[session]/[harness]
  entry").
- Old `provider = "string"` shape continues to mean exactly what it
  did in v2 for bare names ("memory", "anthropic", etc.) — those are
  built-ins.
- The shape that changes is the `[extensions]` table and the
  introduction of `source = { npm = "..." }` / `path = "..."` /
  `git = "..."` specs.

Test fixtures, the sample agent, and the `samples/cli` project get
updated in the same change. The internal-docs/v0 + v1 docs stay as
historical record.

---

## 6. Worked example — before and after

### 6.1 v2 (today)

```toml
[agent]
name = "research-agent"
system_prompt = "./identity.md"

[harness]
provider = "anthropic"
model = "claude-sonnet-4"

[session]
provider = "compacting"
threshold = 50

[tools]
read_file = "builtin"
write_file = "builtin"
fetch_url = "builtin"
mcp_filesystem = "builtin"
mcp_shell = "builtin"

[capabilities]
read_file = { paths = ["./"] }
write_file = { paths = ["./"] }
fetch_url = "*"
mcp_filesystem = "*"
mcp_shell = "*"

[extensions]
"@my-org/loom-fetch" = {}
"@my-org/mcp-pack" = { server = "stdio" }
```

The reader has to know: (a) `fetch_url` comes from the `@my-org/loom-fetch`
package; (b) `mcp_filesystem` and `mcp_shell` come from `@my-org/mcp-pack`;
(c) the `server = "stdio"` config flows into `@my-org/mcp-pack`'s
`register()` and is read by it. None of this is in the manifest text —
it's convention plus reading the package source.

### 6.2 v3

```toml
[agent]
name = "research-agent"
system_prompt = "./identity.md"

[harness]
provider = "anthropic"
model = "claude-sonnet-4"

[session]
provider = "compacting"
threshold = 50

[tools]
read_file = {}                                     # default: builtin
write_file = {}                                    # default: builtin

[tools.fetch_url]
provider = "@my-org/loom-fetch"

[tools.mcp_filesystem]
provider = "@my-org/mcp-pack"
server = "stdio"                                   # config sits here, visible

[tools.mcp_shell]
provider = "@my-org/mcp-pack"
server = "stdio"

[capabilities]
read_file = { paths = ["./"] }
write_file = { paths = ["./"] }
fetch_url = "*"
mcp_filesystem = "*"
mcp_shell = "*"
```

Every package the agent uses is named at the call site. The
`@my-org/mcp-pack` package is loaded once (Loom dedupes the two
references), its `Provider` is asked to resolve each tool, and the
`server = "stdio"` config flows in as the tool's config alongside the
`provider` field. No global "extensions" header. No hidden
name-claiming.

`loom install` in this directory writes `.loom/package.json` with
`@my-org/loom-fetch` and `@my-org/mcp-pack` as deps, runs
`npm install`, and writes `.loom/lock.toml`. `loom run` picks it up
from there.

---

## 7. Type changes

In `src/types/manifest.ts`:

```typescript
/** Where the code for a factory lives. */
export type SourceSpec =
  | "builtin"
  | { npm: string; version?: string }
  | { path: string; subpath?: string };
// future: | { git: string; rev?: string; subpath?: string };

/** A fully-resolved provider reference (the table form). */
export interface ProviderRefTable {
  /** Factory name inside the resolved package. Defaults per §1.2. */
  name?: string;
  /** Source spec. Defaults to "builtin". */
  source?: SourceSpec;
}

/** What appears in [harness].provider, [session].provider, or
 *  [tools.<key>].provider — string fast-path or explicit table. */
export type ProviderRef = string | ProviderRefTable;

/** Parsed/normalised form Loom works with internally — fast-path
 *  expanded into the canonical table. */
export interface NormalisedProviderRef {
  name: string;         // factory name in the package's registry
  source: SourceSpec;   // never undefined post-normalisation
}

/** A tool entry — config + optional provider routing. */
export interface ToolEntry {
  provider?: ProviderRef;
  [config: string]: unknown;
}

export interface HarnessSpec extends ToolEntry {
  provider: ProviderRef;   // required for [harness]
}

export interface SessionSpec extends ToolEntry {
  provider: ProviderRef;   // required for [session]
}

export interface AgentManifest {
  manifestPath?: string;
  name: string;
  description?: string;
  systemPrompt?: SystemPromptSpec;
  secrets?: SecretAllowlist;
  harness: HarnessSpec | Harness;
  session?: SessionSpec | Session;
  tools?: Record<string, ToolEntry>;
  capabilities?: Capabilities;
  // extensions field removed.
}
```

Note that the SDK-direct shape — passing a constructed `Harness`
or `Session` *instance* — still works (the `… | Harness` /
`… | Session` union). Only the *config* form changes.

---

## 8. Implementation plan

Three steps, each landed independently with tests:

### Step A: types + parser

- Update `src/types/manifest.ts` with the new shapes (above).
- Rewrite `src/manifest/parser.ts`:
  - Reject `[extensions]` with the migration error message.
  - Parse `provider` as `string | ProviderRefTable`.
  - Validate `SourceSpec` shape (exactly one of `npm`/`path`/etc.).
  - Normalise the string fast-path into `NormalisedProviderRef` at
    parse time so downstream code only sees one shape.
  - Reject reserved keys (`name`, `source`) appearing outside
    `provider = { … }`.
- Update fixtures (`test/fixtures/sample-agent/agent.toml`) and
  manifest tests.

### Step B: runtime loading + per-package routing

- Replace `collectExtensionFactories` with a source-resolver that
  walks all `provider` refs in the manifest and loads each distinct
  package once (a `Map<sourceKey, PackageScope>`).
- Rewrite the tool-resolution loop in `run-agent.ts`:
  - For each `[tools].<key>`, look up its provider:
    `provider = "builtin"` → native provider; package source → that
    package's `Provider` (or named tool factory).
  - Manifest-wins dedup against session-contributed tools is
    preserved.
- Update `audit/audit.ts` to use the same source-resolver, so
  package-named factories appear in the tree.
- Update tests.

### Step C: `loom install` + lockfile

- Replace the existing `loom install <tool|agent> <path>` command
  (which was for the `~/.loom/registry` flow — orthogonal to v3) with
  the new manifest-dep install.
- Implement the harvest → generate `package.json` → `npm install` →
  write `lock.toml` flow in `src/cli/install.ts`.
- Implement `lock.toml` reader; teach `loom run` and `loom audit` to
  add the locked locations to the extension search path.
- Add `--frozen` and `--install` flags.
- Tests: install against a local fixture package, install against an
  npm package (mocked), lockfile round-trip.

The existing tool/agent installer (the `~/.loom/registry` thing) gets
moved under `loom registry install <tool|agent> <path>` or similar —
it's orthogonal but uses the same word, and we shouldn't drop the
feature.

---

## 9. Open questions to revisit during implementation

These are deliberately left for the implementation phase rather than
pre-decided here:

1. **Symlink vs copy for `path = "../local"` sources.** Symlink is
   faster and tracks edits live; copy is more reproducible. I lean
   symlink for dev ergonomics, with the install command warning when
   it does it. Confirm during step C.
2. **What does `loom install --frozen` do when `lock.toml` is
   missing?** Most likely: error out and tell the user to run a
   non-frozen install first. Confirm during step C.
3. **Tool `provider` key default — `"builtin"` or "must be set"?**
   Defaulting keeps `[tools] read_file = {}` working as today. The
   alternative is to require `provider = "builtin"` everywhere, which
   is more explicit but noisier. I lean default-to-builtin. Confirm
   during step A.
4. **Should `[harness].provider = "string"` allow a path source
   shorthand?** `provider = "./local-pkg"` would auto-detect path
   from the leading `./` (also `../`). Convenient for dev. Confirm
   during step A.

---

## 10. What this doc does NOT cover

- **The `loom run` / `loom serve` / output-shape design** (project 2
  in the roadmap). That's a separate design doc once v3 lands. The
  CLI commands here just need enough to call `runAgent` against a
  v3-parsed manifest.
- **ACP first-class support** (project 3). Independent of v3. Will
  use the same `provider` grammar if ACP-specific factories appear,
  but doesn't need any new manifest shape work.
- **Caching deps across multiple agents.** §3.5 acknowledges it;
  v3 doesn't address it.
- **A registry / discovery mechanism** beyond npm + local paths. v3
  uses npm as the package manager because it's already what the
  loader walks; a future `[registry]` would let users point at
  alternate package indexes.
