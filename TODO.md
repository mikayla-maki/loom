# Scope list

Deferred work, in rough priority order. The capability/tool-group system it
builds on has shipped; see the README "Capabilities reference" for context.

Standing invariant to preserve in all of it: **everything auto-dedups and
simplifies**. However many skills, sessions, and manifest entries refer to
the same tool or the same provider, exactly one instance exists — tool
entries unify by (instance name, implementation) with grants row-unioned;
provider instances unify by (source, config) VALUE, regardless of whether
the value was spelled inline, as a handle, or in different scopes.

## Simplification gaps

- `defaultMerge` dedups exact-duplicate rows but doesn't collapse subsumed
  ones (a row contained in another row survives the union). Quotient by
  `contains` — safe when provable, tools can refine via `mergeGrants`.
- Contributed providers (below) must dedup by value across spellings: an
  inline configured table and a configured handle with an equal value must
  produce the same instance dedup key.
- Skill name collisions across roots: apply a precedence rule (first root
  wins) and dedup the catalog, per the agentskills guidance, instead of
  listing both.

## Session-extended CLI

Sessions should be able to contribute subcommands to the `loom` CLI when
running against a manifest ambiently, e.g. the skills session contributing:

    loom skills install <url>
    loom skills list

`install` fetches a skill, compiles its tool group, runs `applyToolGroups`
against the manifest's effective ceiling, shows the verdicts, and offers to
append each rejection's `remediation` line to `[capabilities]` —
interactive consent instead of copy-paste, same authority model (the human
stays the author of the manifest). The verdict machinery already produces
the paste-ready TOML; this is plumbing plus a prompt.

## Read-only path grants

`paths` grants are read-write binds today. Contributed tool groups make the
distinction matter: a skill directory bound rw into a sandbox lets a
prompt-injected agent rewrite the skill's own scripts — persistence across
sessions. bwrap has `--ro-bind`; sandbox-exec distinguishes
`file-read*`/`file-write*`. Needs a grant-vocabulary extension (e.g.
`paths_ro`) and the algebra to match.

## Cross-platform broker coverage

The bash sandbox broker (per-command rows reaching into pipelines and
interpreters) is implemented and exercised on macOS `sandbox-exec`. The
Linux `bwrap` path is wired through the same code but untested on Linux
here; needs verification on a Linux host (the broker integration tests are
gated on a working sandbox backend, so they exercise it automatically once
there is one).

## lazy SDK loading (~77ms/~33MB off boot) and the spread-based `renameTool` refactor so the next optional `Tool` method can't get silently dropped.
