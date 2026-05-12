# Implement Plugin Storage

A self-contained kickoff prompt. Pass this to a fresh session along
with the repo to do the work.

---

## Context

Loom plugins — sessions, harnesses, MCP factories, future Tools
contributions — keep wanting disk state. Today they each invent
their own path scheme:

- `loom-notes-provider` takes a manifest-relative `file = "./loom-notes.md"`
  config. The user picks where.
- `file` session takes a `path` config.
- A future MCP factory will want a cache directory for
  `tools/list` results, server-PID files for clean shutdown
  across crashes, possibly reauth tokens.
- Harnesses might want to cache model lists or response logs.

Each plugin picking its own convention means the user can't predict
where any of it lives, can't move it, can't back it up coherently.
We want one rule: **each agent gets exactly one storage root, and
every plugin instance puts its stuff somewhere under there.**

The root is platform-appropriate (XDG on Linux, `~/Library/Application
Support/` on macOS) and uniquely identified per agent (with the
manifest's `[agent].name` as the default key). Loom creates the
directory and hands its path to plugins via `FactoryContext`.
That's it. No key-value abstraction, no enforced sub-layout — Loom
provides one path, plugins do whatever they want underneath.

### Design choices (already settled)

1. **Identifier: `[agent].storage_id` if set, else `[agent].name`.**
   The user owns identity. The manifest's name is meaningful and
   move-stable. When two manifests pick the same name and that's
   not what the user wanted, an explicit `storage_id` override
   disambiguates. Path-based hashing isn't used — moving
   `agent.toml` doesn't lose state.

2. **Collision detection: warn and continue.** On first creation,
   Loom drops a `.loom-agent` metadata file recording the manifest
   path. On subsequent boots from a different manifest path with the
   same `storage_id`, log a warning (and surface it in `loom audit`)
   but proceed. Two scribes deliberately sharing state is a
   legitimate use case; two scribes accidentally sharing state is a
   user error the warning makes visible.

3. **Layout: anything goes.** Loom creates the root directory and
   that's all. No enforced `sessions/`, `tools/`, `harnesses/`
   structure. Each plugin lays out its own files under the root.
   Plugins are encouraged (in docs, not code) to namespace by
   their factory name, but it's a convention, not a contract.

4. **Platform-aware root.** macOS gets `~/Library/Application
   Support/Loom/`; Linux gets `$XDG_DATA_HOME/loom/` (default
   `~/.local/share/loom/`); Windows gets `%APPDATA%/Loom/`. The
   `LOOM_DATA_HOME` env var overrides everything when set (useful
   for tests, CI, sandboxing).

### After this lands

- `FactoryContext` carries a `storage: string` field — an absolute
  path to a directory Loom guarantees exists.
- The notes provider defaults to `<storage>/notes.md` instead of
  `./loom-notes.md`. Existing `file` config still works as an
  override.
- The future MCP factory uses `<storage>/mcp/<provider-handle>/`
  for cache and PID files without inventing its own convention.
- `loom audit` displays the resolved storage path. Collision
  warnings show in audit output too.

### Code state when you start

- `src/types/interfaces.ts` defines `FactoryContext`. Currently:
  `{ manifestDir, agentName, loomVersion, clientCapabilities }`.
  Storage gets added here.
- `src/sdk/run-agent.ts` builds `factoryCtx` early in `runAgent`.
  Storage resolution slots in there.
- `src/audit/audit.ts` builds its own `factoryCtx`. Same change.
- `loom-notes-provider` (`examples/loom-notes-provider/index.ts`)
  resolves `config.file` against `ctx.manifestDir` today. After
  this lands, it should fall back to `ctx.storage`.
- 307 tests pass.

---

## Implementation plan

Land each chunk in its own checkpoint. Run `npx tsc -p tsconfig.json
--noEmit` and `npm test` after each.

### Chunk 1: storage root resolution

A pure function — given the host environment, return the data home
for Loom. No filesystem side effects.

In `src/runtime/storage.ts`:

```ts
/**
 * Resolve the per-host root under which all Loom agent storage
 * lives. Honors `$LOOM_DATA_HOME` first; else platform conventions:
 *
 *   macOS:   ~/Library/Application Support/Loom
 *   Linux:   $XDG_DATA_HOME/loom (default ~/.local/share/loom)
 *   Windows: %APPDATA%/Loom
 *   other:   $HOME/.loom
 */
export function resolveLoomDataHome(env: NodeJS.ProcessEnv = process.env): string;
```

Tests in `test/storage.test.ts`:

- macOS path when `process.platform === "darwin"` (mock).
- Linux path with and without `XDG_DATA_HOME`.
- `LOOM_DATA_HOME` override on every platform.
- Fallback when `HOME` is unset (use `os.tmpdir()` or throw — pick
  one; throw is probably cleaner).

No FS side effects in this chunk. Pure function, fully tested.

### Chunk 2: per-agent storage directory

A function that takes a manifest and returns the agent's storage
root, creating it on disk if needed and writing the metadata file
on first creation.

```ts
export interface AgentStorage {
  /** Absolute path. Loom guarantees this directory exists. */
  path: string;
  /** Source of the identifier — useful for diagnostics. */
  source: "storage_id" | "name";
  /** Collision warnings, if any. */
  warnings: string[];
}

export async function resolveAgentStorage(
  manifest: AgentManifest,
  env?: NodeJS.ProcessEnv,
): Promise<AgentStorage>;
```

The function:

1. Picks the identifier: `manifest.storageId ?? manifest.name`.
   (Add `storageId?: string` to `AgentManifest` and parse it from
   `[agent].storage_id`.)
2. Sanitizes it for use as a directory name. The identifier MAY
   contain slashes (treat as illegal) or other path-unfriendly
   chars (sanitize: replace anything matching `[^A-Za-z0-9._-]`
   with `_`).
3. Computes the path: `<dataHome>/agents/<sanitized-id>`.
4. Ensures the directory exists (`mkdir -p`).
5. Reads `.loom-agent` if it exists; compares `manifestPath`
   against `manifest.manifestPath`; if they differ, adds a
   warning to the result.
6. Writes/updates `.loom-agent`. Structure:

   ```json
   {
     "agentName": "scribe",
     "storageId": "scribe",
     "createdAt": "2024-...",
     "createdByManifest": "/path/to/original/agent.toml",
     "lastSeenAt": "2024-...",
     "lastSeenByManifest": "/path/to/current/agent.toml",
     "knownManifests": ["/path/to/original/...", "/path/to/current/..."]
   }
   ```

   `knownManifests` accumulates every distinct manifest path that
   has opened this storage. Useful for users investigating "what's
   in here and where did it come from?"

7. Returns the `AgentStorage` with the path, identifier source,
   and any warnings.

Tests:

- Fresh storage: creates the dir, writes metadata, no warnings.
- Re-open with same manifest path: no warning.
- Re-open with different manifest path: warning surfaces; metadata
  updated to reflect new `lastSeenBy` and `knownManifests` grows.
- `storage_id` explicit override takes precedence over `name`.
- Sanitization: name with `/` rejected (or sanitized — pick); name
  with spaces/punctuation gets cleaned up.
- Pre-built `Session`/`Harness` agents (no manifest path) still
  get a storage path (use `agentName` only; metadata records
  `manifestPath: null`).

### Chunk 3: parser + types

Add `storage_id?: string` to `[agent]` parsing.

- `src/types/manifest.ts`: `AgentManifest` gains optional
  `storageId?: string`.
- `src/manifest/parser.ts`: `parseAgentManifest` reads
  `agent.storage_id` (snake_case in TOML, camelCase in JS — same
  as `agent.system_prompt` → `manifest.systemPrompt`). Validate as
  a non-empty string with the same allowed-character rules as
  storage-directory names.
- A new test in `test/manifest.test.ts` for the parsing.

### Chunk 4: wire into FactoryContext

- `src/types/interfaces.ts`: `FactoryContext` gains
  `storage: string` (the absolute path resolved by Chunk 2).
- `src/sdk/run-agent.ts`: call `resolveAgentStorage(manifest)`
  early in `runAgent`, before building `factoryCtx`. Populate the
  field. Emit any warnings via `console.warn` (or whatever channel
  is appropriate; `RunningAgent.warnings` may be a future home, but
  for now `console.warn` is fine).
- `src/audit/audit.ts`: same storage resolution. Audit shouldn't
  emit warnings to `console.warn`; instead surface them on the
  `CapabilityTree` (see Chunk 5).
- Existing tests should keep passing — no plugin uses the field
  yet.

### Chunk 5: audit surface

`CapabilityTree` gains:

```ts
interface CapabilityTree {
  // ... existing ...
  storage: {
    path: string;
    source: "storage_id" | "name";
    warnings: string[];
  };
}
```

`formatCapabilityTree` renders this near the top of the output,
right under `name`:

```
loom-demo  (examples/agent.toml)
  storage: ~/.local/share/loom/agents/loom-demo  (from [agent].name)
  ⚠ storage was created by /other/agent.toml; sharing state intentional?
  providers:
    ...
```

When there are no warnings, just the path line.

Tests in `test/audit.test.ts`: verify the path renders, warnings
render, and the source label distinguishes `name` from `storage_id`.

### Chunk 6: migrate the notes example to use storage

Update `examples/loom-notes-provider/index.ts`:

- `readSessionConfig`: if `config.file` is provided, use it (current
  behavior). Otherwise, default to `path.join(ctx.storage, "notes.md")`.
- Update the docstring and example to reflect the new default.

Update `examples/agent.toml`:

- Drop the explicit `file = "./loom-notes.md"` from the notes
  layer. Add a comment noting where the default lives:
  `# file = "..."  # optional; defaults to <agent-storage>/notes.md`.

Update `examples/agent.ts`:

- Same drop, same comment.

Update `examples/README.md`:

- Note that the notes are now stored under the agent's storage
  root by default. Mention the path users will see (mention
  `~/Library/Application Support/Loom/...` and
  `~/.local/share/loom/...` so users on either OS can find their
  notes).

### Chunk 7: docs

- `README.md`: a new section (or addition to "What's in the box")
  describing per-agent storage and the `[agent].storage_id` override.
- `internal-docs/manifest-v5.md`:
  - Add `storage_id` to the `[agent]` field list.
  - Mention `FactoryContext.storage` in the plugin-authoring
    section (§2 or §3).
- Mention in `examples/README.md` (as part of Chunk 6).

---

## Working style

- **One chunk per response.** Stop after each with a status report.
- **Typecheck + tests must be clean** before moving on.
- **No new dependencies.** `os.platform()`, `process.env`,
  `fs.promises` — that's enough. Don't pull in `env-paths` or
  `xdg-basedir`; the logic is 30 lines.
- **Storage is created lazily on `runAgent` / `auditAgent`, not on
  manifest parse.** Parsing a manifest is a pure read; resolving
  storage is a side effect. Keep them separate.

---

## Things to deliberately NOT do

- **No key-value abstraction.** Loom gives plugins one path.
  Plugins decide what to put there. No `ctx.storage.read(key)` /
  `ctx.storage.write(key)` API. The path is enough.
- **No enforced sub-layout.** Loom doesn't create `sessions/`,
  `tools/`, `harnesses/` subdirectories. Plugins lay out their
  files however they want under the root. The metadata file
  `.loom-agent` is the only thing Loom owns.
- **No auto-cleanup.** Storage directories accumulate. If the user
  renames an agent or deletes its manifest, the old storage stays.
  A `loom storage gc` command is a future concern, not part of this
  work.
- **No hash-based fallback.** If the user picks a name that
  conflicts, the answer is a `storage_id` override or renaming
  one of the agents. Loom doesn't silently disambiguate by
  hashing the manifest path; that hides the user's mistake.
- **No migration tool.** Plugins that move to the new default
  (like the notes provider in Chunk 6) just change their default.
  Existing files on disk from the old location aren't auto-copied
  — users with old setups keep using the explicit `file` config.
- **No per-instance namespacing built in.** A plugin instance with
  config-derived differences (e.g. two MCP factories pointing at
  different servers) is responsible for not stomping on its
  siblings. Convention: namespace by factory name and a
  config-derived sub-key. Loom doesn't enforce it.

---

## Definition of done

- `FactoryContext.storage` is populated everywhere it's used
  (`runAgent`, `auditAgent`, anywhere else that builds the
  context).
- Running `loom audit examples/agent.toml` shows the resolved
  storage path under the agent name.
- The notes example uses storage by default; running the agent
  once and inspecting `~/Library/Application Support/Loom/agents/loom-demo/notes.md`
  (or the Linux equivalent) shows the saved notes.
- Two manifests with the same `[agent].name` but different paths
  emit a collision warning at boot and in audit.
- `LOOM_DATA_HOME=./scratch loom run examples/agent.toml` honors
  the override (useful for sandboxed test runs).
- `npx tsc -p tsconfig.json --noEmit` returns 0 errors.
- `npm test` passes; new tests cover root resolution, agent
  storage creation, collision detection, parser changes, audit
  surfacing.
- README + manifest-v5 docs updated.

Good luck.
