# Implement Loom Manifest v5

A self-contained kickoff prompt for the v5 implementation pass. Pass
this to a fresh session along with the repo to continue the work.

---

## Context

You are continuing work on **Loom**, a manifest-driven agent
meta-harness. The codebase currently implements **manifest v4**
(see `internal-docs/manifest-v4.md`). Your job is to migrate the
implementation to **v5**, which is fully specified in
`internal-docs/manifest-v5.md` — read that doc first; it's the
canonical design.

### What v5 changes, in one paragraph

v4 had five manifest tables (`[plugins]`, `[providers]`, `[harness]`,
`[session]`, `[tools]`) and two reference field names (`kind` for
harness/session, `provider` for tools). v5 collapses the design to
**one reference word, one declaration table, one resolution rule**.
The `[plugins]` table is renamed to `[providers]`. The v4
`[providers]` table (which held configured-instance handles) is
**removed entirely** — its sharing semantics are carried implicitly
by the resolver's anonymous-instance dedup (key by `(resolved source,
config-hash)`). `kind` is renamed to `provider` everywhere. The
plugin loader's `LoomPluginApi` becomes `LoomProviderApi`; its three
registration methods are renamed to match `register<X>` returns `X`:
`registerTools`/`registerHarness`/`registerSession`. The runtime
`Provider` interface (the tool-routing class) is renamed to `Tools`.

### Code state when you start

- v4 implementation is landed. ~271 non-ACP tests pass.
- ACP tests (`test/acp.test.ts`, `test/acp-initialize.test.ts`) fail
  on pre-existing missing-file imports from `src/acp/framing.ts` and
  `src/acp/messages.ts` (deleted in earlier work; imports never
  updated). Not your problem unless you want to fix them too.
- `src/runtime/boot.ts` already factors out the shared pipeline used
  by both `runAgent` (strict) and `auditAgent` (lenient). Keep that
  pattern. New shared machinery goes there.
- The example provider at `examples/loom-demo-plugin/` (will be
  renamed in chunk 8) demonstrates the v4 plugin contract end-to-end.

---

## Implementation plan

Land each chunk in its own checkpoint. Run `npx tsc -p tsconfig.json
--noEmit` and `npm test` after each. Don't move on until typechecks
are clean and tests pass.

### Chunk 1: Types + parser

- `src/types/manifest.ts`:
  - Rename the `Plugins` type (table) to `Providers`. **Drop** the v4
    `Providers`/`ProviderEntry` types entirely (configured-instance
    table is gone).
  - On `HarnessSpec` / `SessionSpec`: rename the `kind` field to
    `provider`.
  - `ToolEntry`/`ToolEntryTable`: `provider` field is unchanged in v5.
- `src/manifest/parser.ts`:
  - Parse `[providers]` (the SourceSpec-handle table); drop
    `[plugins]` parser.
  - Parse `provider` (not `kind`) on harness/session blocks.
  - **Reject** the v4 `[providers]` configured-instance form with a
    parse error referencing §1.5 of v5 (dedup carries it).
  - Reject `kind = "..."` on harness/session with a pointed error
    naming the v5 rename.
  - Anonymous-instance dedup logic stays in the resolver, not parser.

### Chunk 2: Resolver

- `src/manifest/resolver.ts`:
  - Tool resolution now has **one rule**, not the v4 named-vs-anonymous
    fork:
    1. `provider` absent → for `[tools.X]`, defer to native registry
       by tool key.
    2. Bare handle → look up `[providers]` table first, then built-in
       registry (harness/session/tool-provider, depending on slot).
    3. SourceSpec (string with `/` or `@` or `./`, or table with
       `npm`/`path`/`git` key) → inline auto-load.
  - Keep the anonymous-instance dedup machinery — it's the load-bearing
    piece that makes shared instances implicit. Key: `(resolved source,
    canonicalised config JSON)`.
  - `HarnessBinding`/`SessionBinding`/`ToolBinding` IR shapes
    unchanged; only the field they're populated from changes.

### Chunk 3: Plugin loader rename

- Move `src/plugins/loader.ts` → `src/providers/loader.ts`. Update
  every import across the tree.
- Renames:
  - `LoomPluginApi` → `LoomProviderApi`
  - `LoomPluginModule` → `LoomProviderModule`
  - `PluginPackageInfo` → `ProviderPackageInfo`
  - `LoadedPlugin` → `LoadedProvider`
  - `loadPluginByName` → `loadProviderByName`
  - `loadPluginFromPath` → `loadProviderFromPath`
  - `loadPluginFromSource` → `loadProviderFromSource`
  - `locatePluginPackage` → `locateProviderPackage`
  - `listInstalledPlugins` → `listInstalledProviders`
  - `loom.plugin` package.json field → `loom.provider`. Hard cut.
- Reshape `LoomProviderApi`:
  - **Remove** `registerProviderType`.
  - **Add** `registerTools(reg: ContributionRegistration<Tools>)`.
  - Keep `registerHarness` / `registerSession` but unify their
    signature to `ContributionRegistration<T>` (shared shape).
  - Rename `pluginName` field → `providerName`.
- `runtime/boot.ts`:
  - Rename `materialisePluginProvider` → `materialiseTools`.
  - Rename `ProviderTypeIndex` → `ToolsIndex` (or similar).
  - `loadManifestPlugins` → `loadManifestProviders`.

### Chunk 4: Runtime `Provider` → `Tools` rename

- `src/types/interfaces.ts`: rename the `Provider` interface to
  `Tools`. (The interface has `resolveTool`, `init`, `close`.)
- `src/sdk/run-agent.ts`: rename `Provider` references → `Tools`;
  `MaterialisedProvider` → `MaterialisedTools`.
- Update `Tools.create` signature: now takes `(config, ctx, secrets,
  parent?)` — same as harness/session. The v4 `ProviderType.create`
  only got `config`; v5 unifies the four-arg signature across all
  three contribution types.
- The `instantiateFromBinding` helper in `boot.ts` already works for
  harness/session; consider also routing `Tools` instantiation
  through it for symmetry (or keep `materialiseTools` separate since
  Tools instances need dedup-keyed caching).

### Chunk 5: Built-in registration refactor (optional but recommended)

- Today's built-ins live in two places:
  - `src/builtins/index.ts` — global harness/session registries.
  - `src/builtins/provider/native.ts` — hand-rolled `Tools`.
- Refactor so all built-ins register through the same
  `LoomProviderApi` shape during boot. The runtime initialises
  them once before any agent loads, using a synthetic "builtin"
  provider source.
- **If this gets gnarly, defer it.** Keep built-ins on their current
  code path and have only plugin-contributed registrations use the
  new shape. The user-facing v5 grammar lands either way; this is
  internal cleanup that improves architectural consistency.

### Chunk 6: Audit

- `src/audit/audit.ts`:
  - Rename internal `Provider` references → `Tools`.
  - Rename the audit's `CapabilityTree.plugins` field →
    `CapabilityTree.providers`.
  - `PluginSummary` type → `ProviderSummary`.
  - `formatCapabilityTree` output: section heading `plugins:` →
    `providers:`. Per-tool `via plugin 'X'` → `via provider 'X'`.

### Chunk 7: CLI

- `src/cli/main.ts`:
  - Rename the `cmdExtensions` / `cmdPlugins` function to
    `cmdProviders`.
  - Subcommand `loom plugins list/info` → `loom providers list/info`.
  - Update help text everywhere: "plugins" → "providers".

### Chunk 8: Examples + tests + fixtures

- `examples/loom-demo-plugin/` → `examples/loom-demo-provider/`
  (rename the dir for full consistency).
- `examples/loom-demo-provider/index.ts`: use `LoomProviderApi` +
  `registerTools` + `Tools` type. Rebuild the committed `index.js`
  with `npm run build` in the example dir.
- `examples/minimal-agent.toml`: `[plugins]` → `[providers]`, `kind`
  → `provider` on `[harness]`/`[session]`.
- Test fixtures: bulk find-and-replace inside test files:
  - `kind:` → `provider:` (only in `[harness]` and `[session]`
    contexts — avoid `[capabilities]` keys named `kind`).
  - `[plugins]` → `[providers]`.
  - `registerProviderType` → `registerTools`.
  - Any inline `AgentManifest` literal constructed in test code:
    `harness: { kind: ... }` → `harness: { provider: ... }`.
- `test/fixtures/sample-agent/agent.toml`: same shape update.

### Chunk 9: Docs

- Mark `internal-docs/manifest-v3.md` and
  `internal-docs/manifest-v4.md` as historical at the top.
- Update top-level `README.md` to use v5 vocabulary (it currently
  references v2 `[extensions]` in places).

---

## Working style

- **One chunk per response.** Stop after each chunk with a status
  report: what changed, typecheck count, test count.
- **Typecheck + tests must be clean** before moving on:
  - `npx tsc -p tsconfig.json --noEmit` returns 0 errors in v5-touched
    files (pre-existing ACP errors in `src/acp/` are not your problem)
  - `npm test` shows the same pass count as before, plus or minus
    whatever the v5 changes legitimately move
- **Use `runtime/boot.ts` for any new shared machinery.** Don't
  duplicate code between runtime and audit — they already share a
  pipeline; keep it that way.
- The `lookupFactoryByBinding` pattern in `boot.ts` (which falls
  back to the package name when a `[providers]` handle doesn't match
  a registered factory) is load-bearing for the v5 convention "primary
  factory = package name." Carry it forward.

---

## Final sanity check when done

`loom audit examples/minimal-agent.toml` (after the example is
updated) should produce output structurally identical to what v4
produces today, just with:

- `plugins:` heading → `providers:`
- `via plugin 'X'` → `via provider 'X'`
- `[providers]` table referenced as the source of declared handles

Compare before/after to verify no regressions in audit semantics.

---

## Things to deliberately NOT do

- **No soft back-compat shims** for old field names. Hard cut.
  Nothing's shipped externally.
- **No new conceptual layer** to ease the migration. The point of
  v5 is *fewer* concepts, not more.
- **No mixing of "Provider" and "Tools" in the same docstring or
  method signature** except where v5 explicitly does so. The
  vocabulary separation is the win — preserve it.

---

## Definition of done

- All chunks landed
- `npx tsc -p tsconfig.json --noEmit` returns 0 errors in v5 code
- `npm test` matches the pre-v5 baseline (271 non-ACP tests passing)
- `loom audit examples/minimal-agent.toml` runs clean and reads
  well
- `internal-docs/manifest-v5.md` is the only design doc not marked
  historical
- `README.md` leads with v5 vocabulary

Good luck.
