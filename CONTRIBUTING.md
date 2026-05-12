# Contributing to Loom

Loom is early. Issues, ideas, and PRs all welcome.

## Setup

```sh
git clone https://github.com/<you>/loom.git
cd loom
npm install
npm run build
npm test
```

Node 20 or newer. No other prerequisites.

## What's where

```
src/
  types/          # manifest types, runtime interfaces, ACP types
  manifest/       # parser → resolver → capabilities (pure, no I/O beyond reading agent.toml)
  runtime/        # tool table, update sink, sandbox profiles, shared boot helpers
  builtins/       # bundled harnesses (anthropic, openai, test) + sessions (memory, file, ...) + tools (bash, read_file, ...)
  providers/      # npm/path discovery and the LoomProviderApi glue
  sdk/            # runAgent() — ties everything together
  acp/            # ACP server adapter
  audit/          # static capability tree + formatter
  cli/            # `loom` CLI

test/             # vitest, 270+ tests; deterministic
examples/         # agent.toml + agent.ts + a working demo provider
internal-docs/    # design docs (manifest-v5.md is canonical)
```

The canonical manifest design is in
[`internal-docs/manifest-v5.md`](./internal-docs/manifest-v5.md).
Read that before touching the parser or resolver.

## House style

- **TypeScript, strict mode.** `noUncheckedIndexedAccess` is on; the
  v5 type rename pass got rid of all back-compat aliases — keep it
  that way.
- **One reference word.** v5 says `provider` is the only field used
  to reference code. Don't reintroduce `kind`, `extension`, `plugin`,
  or anything similar.
- **No migration scaffolding.** Loom hasn't shipped, so we don't
  carry compat shims for prior drafts. Hard cuts only.
- **Vocabulary.** "Provider" is the package/source-layer word.
  "Tools" is the runtime-class word. They don't appear together in
  the same sentence — separation is the win.
- **Capabilities are first-class.** New tools should declare
  `requires`/`optional` and self-police on `this.capabilities` in
  `execute()`. The grant is also what derives the tool's description
  and input schema (single-bucket grant binds the bucket, etc.).
- **Comments are for *why*, not *what*.** The codebase is heavily
  commented; please keep that ratio. If a comment just restates the
  code, delete it.

## Tests

```sh
npm test            # vitest run, ~270 tests
npm run lint        # tsc on src + test
```

Tests are deterministic — no network, no real keys, no timing-
sensitive assertions. Use the `test` harness factory (a scripted
harness) when you need to drive an agent in a unit test.

Whenever you add a public-facing manifest shape or built-in, add a
test under `test/` that exercises it through `runAgent` end-to-end.
Parser- and resolver-level tests are nice but not enough on their own.

## Pull requests

- **Small and focused.** One concept per PR. If you find yourself
  touching unrelated files, split.
- **Update tests in the same PR.** New surface needs new coverage.
- **Update the README / examples** when you change public API. The
  README is what people read first.
- **Commit message style.** Imperative present tense, ~60-char first
  line, explain *why* in the body when it isn't obvious.

## Reporting issues

Include:
- Loom version (commit SHA if you're on `main`).
- Node version.
- Minimal reproducer — ideally an `agent.toml` plus the exact command
  you ran.
- What you expected vs. what happened.

For runtime errors, `loom audit <agent.toml>` output is usually a
good thing to include too.

## License

By contributing you agree your work is MIT-licensed (the project
license). No CLA.
