# Implement Native Session Chaining

A self-contained kickoff prompt. Pass this to a fresh session along
with the repo to do the work.

---

## Context

Loom currently exposes Session as a single block — `[session]` in the
manifest, `session?: SessionSpec | Session` in `AgentManifest`. The
SDK has a `ChainedSession` *class* that composes N sessions (push
top-to-bottom, pull bottom-to-top, aggregate everything else), but
there's no way to express a chain in the manifest. Users who want
"compacting + file" or "skills + memory" either have to construct it
in JS, or write a custom Loom provider package that composes them
internally.

This is a footgun. A user who writes:

```toml
[session]
provider = "file"
path = "./s.jsonl"
```

gets just `file` — no compaction, unbounded growth. The most-wanted
shape (`compacting + something`) has no manifest answer.

### The design decision

**Session chains are *the* composition, not *a* possible composition.**

The Session interface's `push(event) → SessionUpdate[]` and
`pull(below) → SessionUpdate[]` are exactly the composition protocol:
each layer transforms the event stream, with `below` being what the
layer below it produced. Today this protocol is half-real (it's how
`ChainedSession` works internally) but the manifest doesn't expose
it. v5 enshrined `provider` as the universal reference word; this
change enshrines chains as the universal composition shape.

After this lands:

- The manifest accepts `[[session]]` (TOML array-of-tables) for chains
  *and* `[session]` (singleton) for the trivial length-1 case.
- `AgentManifest.session` accepts `SessionSpec | SessionSpec[] | Session`.
- `ChainedSession` ceases to be a public SDK class — it's the
  runtime's composition vehicle, not something users construct.
- Default-when-absent becomes `[compacting, memory]` instead of
  `[memory]`. Bounded growth out of the box.
- `CompactingSession` is reworked into a true pull-side transform
  that operates on `below` instead of a private `inner`. This is the
  prerequisite for putting it in a chain.

### Code state when you start

- All v5 work landed. 279 tests pass.
- `ChainedSession` exists in `src/builtins/session/compacting.ts`
  (next to `CompactingSession`) and is exported from `src/index.ts`.
  It correctly implements push/pull/aggregation; the runtime just
  doesn't use it for manifest-driven sessions.
- `CompactingSession.pull()` ignores its `_below` arg and reads from
  a private `this.inner` instead — it's a hard wrapper, not a
  transform layer. This is the change with the most code in it.
- `SkillsSession` doesn't implement `push`/`pull` at all (no opinion
  on the event stream); it slots into a chain trivially.
- `src/runtime/boot.ts` factors the shared pipeline; new shared
  machinery goes there.

---

## Implementation plan

Land each chunk in its own checkpoint. Run `npx tsc -p tsconfig.json
--noEmit` and `npm test` after each. Don't move on until typechecks
are clean and tests pass.

### Chunk 1: Types

- `src/types/manifest.ts`:
  - Change `AgentManifest.session` from
    `SessionSpec | Session | undefined`
    to
    `SessionSpec | SessionSpec[] | Session | undefined`.
  - Update the JSDoc to explain the three forms: single (one block,
    typical case), chain (array, outer-to-inner), and instance
    (pre-built `Session` from SDK direct construction).
- Don't touch anything else yet; this is just the shape change. The
  parser/resolver/runtime will tighten around it in later chunks.

### Chunk 2: Parser

- `src/manifest/parser.ts`:
  - Accept TOML's array-of-tables form `[[session]]` and parse it
    into `SessionSpec[]`. TOML's parser will already give it as an
    array; just route the array case through `parseSessionSpec`
    per-entry instead of expecting a single table.
  - Keep the `[session]` single-table form parsing exactly as today.
  - Reject mixed shapes (you can't have both `[session]` and
    `[[session]]` in the same file — TOML wouldn't accept that
    anyway, but emit a clean error if it ever surfaces).
  - Empty array `[[session]]` with zero entries → parse error
    (a chain has to have at least one link; for "no session," omit
    the section).

### Chunk 3: Resolver

- `src/manifest/resolver.ts`:
  - Change `ResolvedManifest.session` from `SessionBinding | undefined`
    to `SessionBinding[] | undefined`. Each binding resolves
    independently (existing `resolveFactoryReference` works
    per-entry).
  - When `manifest.session` is a single `SessionSpec` (singleton
    `[session]`), wrap into a length-1 array internally so the
    runtime sees a uniform shape.
  - Pre-built `Session` instance → still bypass resolution, stays
    `undefined` on `ResolvedManifest.session` (the runtime uses the
    instance directly).
  - Keep `[providers]` handle dedup working across all chain entries.
  - Order matters: the resolver's output array must reflect the
    manifest order (outer-to-inner).

### Chunk 4: Move `ChainedSession` to `runtime/`

- Move the `ChainedSession` class out of
  `src/builtins/session/compacting.ts` into a new
  `src/runtime/session-chain.ts`. It's a composition primitive, not
  a session implementation; it doesn't belong under `builtins/`.
- Drop `ChainedSession` from `src/index.ts` exports. The class isn't
  public API any more — SDK consumers compose by passing a
  `SessionSpec[]` (or array of pre-built `Session`s) to `runAgent`.
- Update internal imports in compacting.ts and anywhere else that
  used `ChainedSession` to point at the new location.

### Chunk 5: Runtime — chain assembly

- `src/sdk/run-agent.ts` / `src/runtime/boot.ts`:
  - Rework `instantiateSession` to handle the array case. Build each
    `Session` from its binding, then wrap them in `ChainedSession`
    (outer-to-inner). For a length-1 chain, return the inner session
    directly (no `ChainedSession` wrapper — keep the trivial case
    cheap).
  - When `manifest.session` is a pre-built `Session` instance, pass
    it through unchanged (today's behavior).
  - When `manifest.session` is `undefined` and `resolved.session` is
    `undefined`, use the new default: `[compacting, memory]` (see
    Chunk 8 — this lands after the compacting refactor).
- `src/audit/audit.ts`:
  - Update `auditAgentInner` to walk the chain. The audit pipeline
    instantiates the session (already does, via
    `instantiateFromBinding`) — just adapt it to instantiate each
    link and compose.
  - The audit summary needs a chain-aware shape (see Chunk 6).

### Chunk 6: Audit output

- `src/audit/audit.ts`:
  - `CapabilityTree.session` becomes `SessionAuditSummary[]` (one per
    link) instead of a single `SessionAuditSummary | undefined`. Or
    keep the old shape for the singleton case and add a sibling
    `sessionChain?: SessionAuditSummary[]` — choose whichever lands
    cleaner. Goal: JSON consumers shouldn't have to know whether
    they're looking at a chain or a single session if they don't
    care about composition.
  - `formatCapabilityTree`: render each link as its own indented
    block under a single `session:` heading, in chain order. Each
    link gets its existing `provider:` / `config:` / `contributes
    tools:` / `trusted paths:` sub-lines. Length-1 chains render
    identically to today's single-session output (no visible
    difference).

### Chunk 7: Rework `CompactingSession` as a pull-side transform

This is the largest piece. The current `CompactingSession` is a hard
wrapper around `this.inner`. It needs to become a layer that:

- Reads its events from `below` (the chain's events from layers below
  it), not from a private `inner`.
- Caches the summary internally (today's behavior, preserved).
- Triggers compaction in `prepareTurn` when the threshold is met,
  using the events available via the chain context.
- Drops the constructor's `inner` parameter — it no longer wraps.
  SDK consumers who want compaction over file storage now pass a
  chain (`[new CompactingSession(opts), new FileSession(path)]`) to
  `runAgent`, the same way the manifest expresses it.

The tricky bit: the cache needs to know when the event stream below
has grown past the threshold. Options:

- Track the most recent event count seen via `pull(below)` calls;
  recompute the summary when `below.length` jumps past `threshold`
  and the cached coverage is stale.
- Or do the check in `prepareTurn(agent)` — pull events at that
  point, decide whether to compact, update the cache.

The `prepareTurn` route is the same as today and probably easier to
keep tests passing on. But it needs access to events — `prepareTurn`
gets `agent`, not the chain context. One approach: have `prepareTurn`
read events from the agent's session via the runtime layer above
(but that's circular). Simpler: keep `prepareTurn` doing token-based
checks, and use `pull(below)` to do event-count checks lazily.

Open question: where does compaction *write* its result? Today
`CompactingSession` caches in-memory and returns the cached summary
on every `pull`. With pull-side-only, this works unchanged — the
summary is in-memory state on the CompactingSession instance, and
`pull(below)` returns `[...cachedSummary, ...below.slice(-keep)]`
when the cache is present. The layers below never see the summary
events; they keep storing raw events.

The `compactNow(harness)` public method stays — useful for `/compact`
slash commands and SDK callers.

Things that must keep working:

- The existing `compactingMemorySession()` / `compactingFileSession()`
  SDK helpers: easiest path is to keep them as thin
  `ChainedSession`-builders that return a single composed `Session`.
  Update internals to use the new transform shape.
- The `model-compactor.test.ts` and `compacting-session.test.ts`
  test suites — these are the canary for the rewrite. Their
  end-to-end behavior should be unchanged; their fixture
  construction will be slightly different.
- The `tokensInContext` / `contextWindow` getters and
  `usage_update` event handling — must survive the rewrite.

### Chunk 8: Update default-when-absent

- `src/sdk/run-agent.ts`:
  - Change the default from `DEFAULT_SESSION: SessionSpec = { provider:
    "memory" }` to a `DEFAULT_SESSION_CHAIN: SessionSpec[] = [{
    provider: "compacting" }, { provider: "memory" }]`.
  - Pass `compacting` with no config — it'll use its built-in
    defaults (threshold 40, keep 10, heuristic compactor).
  - Update audit's `DEFAULT_TOP_LEVEL_CAPABILITIES`-equivalent for
    sessions if there is one.

### Chunk 9: Tests

New tests required:

- `test/manifest.test.ts`: parser accepts `[[session]]`, rejects
  empty array, distinguishes from `[session]`.
- `test/resolver.test.ts`: resolver produces ordered chain bindings;
  length-1 chains; pre-built instance still bypasses.
- `test/sessions.test.ts` (or a new file): end-to-end through
  `runAgent` — chain of `compacting + memory` actually compacts;
  chain of `skills + file` produces both the skills tools and the
  file persistence; chain order respected.
- `test/compacting-session.test.ts`: update to use the new shape
  (compacting in a chain, not as a constructor-wrapping class).
  Behavior tests (when does compaction fire, what's the cached
  summary shape) carry over.
- `test/audit.test.ts`: chain links each render in the audit tree.
- Update fixtures that currently rely on `ChainedSession` being a
  public class.

### Chunk 10: Examples + docs

- `examples/agent.toml`: switch the example to use the chain form
  for the session (`[[session]]` with compacting + demo + memory or
  similar). Keep the demo provider's session as a chain link.
- `examples/agent.ts`: mirror the chain in JS — pass
  `session: [...] as SessionSpec[]`.
- `examples/README.md`: explain the chain.
- `README.md`:
  - Update the quick-start `[tools]` example to also show
    `[[session]]` for compaction + file persistence (the canonical
    "long-running agent" shape).
  - Update the "What's in the box" section to flag chains as the
    default composition model.
  - Update the SDK snippet to use the array form.
- `internal-docs/manifest-v5.md`: amend §1 (Tables) and the relevant
  section to document `[[session]]`. Add a sub-section explaining
  the chain protocol — push top-to-bottom, pull bottom-to-top, why
  this is THE composition.

---

## Working style

- **One chunk per response.** Stop after each with a status report:
  what changed, typecheck count, test count.
- **Typecheck + tests must be clean** before moving on:
  - `npx tsc -p tsconfig.json --noEmit` returns 0 errors
  - `npm test` shows the pre-chain baseline (279 tests) plus
    whatever new tests this change legitimately adds
- **Use `runtime/` for shared machinery.** `ChainedSession` belongs
  there now, not under `builtins/`. New chain-related code goes
  there too.
- **The compacting rewrite (chunk 7) is the load-bearing chunk.** If
  it's gnarlier than expected, pause and design before coding —
  don't paper over with `instanceof`-checks or special-casing in the
  resolver.
- **The chain protocol is honest about the work.** Don't add a
  short-circuit that bypasses `ChainedSession` for "length-1
  optimization" beyond returning the single session directly (which
  is fine). Don't add a `ChainedSession.pushAndPull()` convenience —
  the protocol is push for writes, pull for reads, full stop.

---

## Things to deliberately NOT do

- **No "default" preset session.** We're not shipping a
  `provider = "default"` that internally composes compacting + memory.
  The chain syntax IS how that's expressed. The default-when-absent
  applies the chain implicitly; users who type one byte of
  `[session]` config get exactly what they wrote.
- **No auto-detection of `./skills/`.** Even though it's tempting.
  Magic FS scans surprise people. Opt-in via the manifest.
- **No `noDefaultSessions` flag.** If the user wrote `[session]` (or
  `[[session]]`) explicitly, that's the chain. The implicit default
  only applies when the section is fully absent.
- **No keeping `ChainedSession` as a public export.** It's runtime
  machinery now. If you find yourself wanting to keep it for SDK
  ergonomics, the answer is: pass a `SessionSpec[]` to `runAgent`
  instead.
- **No unbundling Session into separate Storage / Compactor /
  Skills interfaces.** Out of scope. The point of this work is to
  embrace Session as the composable unit — not to split it.

---

## Definition of done

- All chunks landed.
- `npx tsc -p tsconfig.json --noEmit` returns 0 errors.
- `npm test` passes; test count is the pre-chain baseline (279) plus
  the new chain-related tests.
- `loom audit examples/agent.toml` renders the chain cleanly under
  the `session:` heading, with each link as its own indented block.
- The example agents (both TOML and SDK) demonstrate the chain.
- README + manifest-v5.md updated to lead with the chain as the
  composition model.
- `ChainedSession` is no longer exported from `loom`.
- Default-when-absent gives bounded growth.

Good luck.
