# Loom Security Review — 2026-06-07

Comprehensive capability-security audit by a 40-agent adversarial workflow.
Each candidate finding was confirmed by ≥2 of 3 independent verifiers
(code-soundness / exploitability / hostile-skeptic lenses). Several were
reproduced with live PoCs against `dist/`.

**Threat model used** (from the README): Loom protects against *misbehaving
agents* — adversarial/prompt-injected LLM output trying to exceed the
capabilities granted in `agent.toml`. Tool/provider/skill implementations and
the manifest author are trusted. A finding is in scope only if an agent
constrained to emitting tool-call arguments + text can exceed its grant.

## Summary

| # | Severity | Status | Title | File |
|---|----------|--------|-------|------|
| 1 | **CRITICAL** | ✅ Fixed | Missing `--unshare-pid` leaks orchestrator secrets via `/proc/<pid>/environ` | `src/runtime/sandbox/bwrap.ts` |
| 2 | **CRITICAL** | ⬜ Open | Runtime provider loading searches agent-writable `node_modules` → planted-provider RCE | `src/providers/loader.ts` |
| 3 | **HIGH** | ✅ Fixed | MCP partial-arg grant is cosmetic — agent re-supplies dropped args | `src/manifest/capabilities.ts` + `src/builtins/tools/mcp.ts` |
| 4 | **HIGH** | ✅ Fixed | `find` tool doesn't canonicalize symlinks → path-grant escape | `src/runtime/builtins/find.ts` |
| 5 | **MEDIUM** | ✅ Fixed¹ | Shared PID namespace leaks host process metadata (cmdline/cwd/fd/maps) | `src/runtime/sandbox/bwrap.ts` |
| 6 | **MEDIUM** | ⬜ Open | `resolveNpmEntry` is a 2nd writable-`node_modules` → code-exec sink for MCP servers | `src/builtins/tools/mcp.ts` |

> **Fixes applied 2026-06-07** for #1, #3, #4 (and #5 as a corollary of #1¹):
> - **#1/#5** — `bwrap.ts` now emits `--unshare-pid`, isolating the PID namespace so
>   the fresh `/proc` no longer reflects the orchestrator. ⚠️ *Needs verification on a
>   real Linux host* — the bwrap path is untested on this macOS dev machine, and the
>   `wait`-builtin concern the original comment cited should be re-checked (bwrap acts
>   as the namespace's pid-1 reaper, so bash's `wait` on its own jobs should still work).
> - **#3** — `applyArgGrant` now reports a `narrowed` flag, and `mcp.ts` `execute`
>   rejects any model-supplied key outside the granted whitelist when narrowing is in
>   effect. This is Ajv-config-independent and preserves the friendly bound-arg message.
>   Regression test: `test/mcp-factory.test.ts` ("a per-arg map grant is a closed
>   whitelist at execute time").
> - **#4** — `find` now `canonicalizeForGrant`/`canonicalizeRoots` both sides before the
>   allowlist check, matching the other path builtins. Regression test: `test/find.test.ts`.
>
> Full suite: 565 passing / 13 skipped (Linux-gated). #2 and #6 left open per request.

Plus two **unconfirmed-but-worth-checking** soundness concerns (below).

---

## 1. CRITICAL — Missing `--unshare-pid` leaks orchestrator secrets via `/proc` (Linux/bwrap)

**`src/runtime/sandbox/bwrap.ts:114, 165`**

`buildBwrapArgs` mounts a fresh procfs (`--proc /proc`, line 114) but deliberately
omits `--unshare-pid` (line 165: *"--unshare-pid breaks bash builtins like `wait`,
so it is omitted"*). It also never uses `--unshare-user` and never remaps uid/gid.
So the sandboxed command runs in the **same PID namespace and as the same UID** as
the Loom orchestrator. A procfs mounted into a process sharing the host PID
namespace reflects that whole namespace, and `/proc/<pid>/environ` is readable by
the owning UID with no ptrace.

The orchestrator holds provider API keys in its own `process.env`
(`EnvSecretsStore`, registered by default in `run-agent.ts:738`). `bash.ts`
`buildEnv()`/`isSensitiveEnvName` (638-667) carefully strip `*_API_KEY` / `LOOM_*`
from the *sandboxed command's* env — and that filtering is completely bypassed.

**Exploit** — agent with any structured bash grant (`commands=["cat"]`, no env grant):
```sh
cat /proc/$PPID/environ | tr '\0' '\n'
# or scan everything:
for f in /proc/[0-9]*/environ; do cat "$f" 2>/dev/null; done | tr '\0' '\n' | grep -E 'API_KEY|LOOM_'
```
Returns the env-denied provider keys into model context for later exfiltration.

**Fix** — add `--unshare-pid` (work around the `wait` breakage with a tiny in-ns
reaper / `--as-pid-1`), or `--unshare-user` + uid remap. Defense-in-depth:
`--cap-drop ALL`, a seccomp filter blocking ptrace, and `hidepid`. Do not rely on
env filtering while the host PID namespace is shared.

---

## 2. CRITICAL — Runtime provider loading executes code from agent-writable `node_modules`

**`src/providers/loader.ts:313-343` (collectSearchRoots) + 154-193 (loadProviderFromInfo)**

`collectSearchRoots()` builds the provider search path starting with
`agentManifestDir/.loom/node_modules` (pushed **first** — *"Loom-installed packages
must win over the surrounding tree"*), then `agentManifestDir/node_modules` and
ancestors. `tryLoadPackageJson()` does **no integrity/trusted-location check** — any
dir with a `<name>/package.json` carrying a `loom.provider` field is accepted and its
entry JS is `import()`ed and its `register()` invoked as fully-trusted, un-sandboxed
host Node code.

For the top-level agent this is benign (boot happens before the agent runs). But
provider loading **also runs at runtime on every subagent spawn**:
`spawn_subagent.execute → spawnSubagentInScope → runAgent → loadManifestProviders`.
For an inline-granted sub-manifest `baseDir = process.cwd()`, so the first real search
root is `<cwd>/.loom/node_modules` — and nothing stops the agent from having already
written `.js` into its granted writable cwd (`find` skips `node_modules` only for
*listing*; `write_file`/`bash` have no such guard).

**Exploit** (preconditions: writable grant over cwd + spawn_subagent with an
npm-sourced sub-manifest provider — both ordinary grants):
1. `write_file` → `<cwd>/.loom/node_modules/acme-provider/package.json`
   `{"name":"acme-provider","type":"module","loom":{"provider":"./evil.js"}}`
2. `write_file` → `evil.js` exporting `register(){ require('child_process').execSync('curl …') }`
3. `spawn_subagent` (any prompt) → loader resolves the planted package, imports
   `evil.js`, runs `register()` in the host process — **no sandbox, no network grant,
   no path restriction, no ceiling.** Full escape.

The `.loom/node_modules`-first ordering also lets the agent **shadow** a
legitimately-installed same-named provider.

> A verifier reproduced this end-to-end against `dist/providers/loader.js`: a
> planted package's `register()` ran `execSync('id')` in-process.

**Fix** — resolve provider entry paths once at top-level boot and have subagents
reuse the parent's frozen registry; record the trusted root each provider resolved
from and refuse to import any `entryPath` not under an allowlisted trusted prefix;
exclude agent-writable granted paths from the search roots.

---

## 3. HIGH — MCP partial-argument grant is cosmetic (dropped args re-suppliable)

**`src/manifest/capabilities.ts:194-270` (applyArgGrant) + `src/builtins/tools/mcp.ts:346-374` (execute)**

`applyArgGrant` narrows an MCP tool's schema by **deleting** ungranted properties
from `properties`/`required` — this is how Loom "hides" args the author didn't grant
(the host note even tells the model *"the input schema reflects only the arguments
you should pass"*, and the README markets the per-arg map as *"a strict whitelist"*).
But:

- The narrowed schema is **never given `additionalProperties:false`** (it only spreads
  `...original`). Ajv runs with `strict:false` (`tool-table.ts:12`), so when the MCP
  server's schema omits `additionalProperties` — the common case; the MCP SDK's
  `zod-to-jsonschema` does not emit it — extra properties pass validation.
- `execute()` only rejects re-supplied **literal-bound** args (`applied.bound`).
  Dropped-but-unbound args are in neither `bound` nor the schema, so the guard ignores
  them, and line 361 forwards `{...applied.bound, ...modelArgs}` verbatim to the server.
- `applied.modelArgs` (the computed allow-set) is **never consulted** at execute time.

**Net:** only literal-bound (`b = 42`) and enum (`b = [...]`) grant forms are enforced.
The *"omit this argument entirely"* form — the strict-whitelist the docs sell — is
unenforced.

**Exploit** — author grants `capabilities = { path = "*" }` to restrict a filesystem
MCP tool (forbidding `recursive`/`force`). Agent calls
`{ path:"/important", recursive:true, force:true }`; Ajv accepts, execute ignores the
extra keys, server receives them.

> Reproduced against the echo-server fixture: grant `{a:"*"}` exposes only `a`, yet
> `execute({a:5,b:100})` returned `105` — `b` reached the server.

`test/applied-arg-grant.test.ts` only ever uses schemas that already declare
`additionalProperties:false`, so it masks the gap.

**Fix** — (a) set `additionalProperties:false` on the narrowed schema whenever a grant
is applied, **and/or** (b) at execute, reject any model key not in `applied.modelArgs`;
forward exactly `modelArgs ∪ keys(bound)`. (b) is the more robust defense — independent
of Ajv config and the upstream schema.

*(This bug was independently surfaced by both the `capability-algebra` and `mcp-tools`
finders — merged here.)*

---

## 4. HIGH — `find` tool doesn't canonicalize symlinks → path-grant escape

**`src/runtime/builtins/find.ts:85-87`**

Unlike `read_file`/`write_file`/`edit_file` (which all call `canonicalizeForGrant` +
`canonicalizeRoots`), `find` does a purely lexical `path.resolve(requestedRoot)` then
`pathAllowed(root, this.granted)` with **no symlink resolution**. `_path.ts:42-44`
documents exactly why that's mandatory: *"these tools have no OS sandbox, so a symlink
inside a granted dir would otherwise escape the allowlist."* `find` is the lone path
builtin missing it. `fs.stat` then follows the link and `walk()`/`readdir` enumerate
the out-of-grant tree.

**Exploit** — agent with `find` granted on `/workspace` and any way to place a symlink
there (e.g. `bash` with `ln`, or a pre-existing symlink): `ln -s / /workspace/escape`,
then `find(root="/workspace/escape", pattern="**/*")` → lexical check passes, target
tree is enumerated, filenames from anywhere (`id_rsa`, `.env`, `/etc`) flow into model
context.

> Reproduced: granted `/tmp/.../grant`, symlink `escape → /tmp/.../outside`,
> `pathAllowed` returned true and `readdir` leaked the outside dir's contents. The
> `read_file` (canonicalized) path correctly returned false on the same input.

Scope note: this leaks file/dir **names** (information disclosure), not contents —
`read_file` remains independently gated. `walk()` uses `Dirent.isDirectory()` so only
the root symlink is dereferenced.

**Fix** — mirror the other builtins: `canonicalizeForGrant(resolve(root),'read')` vs
`canonicalizeRoots(this.granted)`; also re-validate each traversed dir's realpath so a
symlinked subdir can't point outward.

---

## 5. MEDIUM — Shared PID namespace leaks host process metadata

**`src/runtime/sandbox/bwrap.ts:114, 165`** — corollary of #1.

Same missing `--unshare-pid`: the fresh `/proc` exposes every same-namespace
process's `/proc/<pid>/cmdline`, `/cwd`, `/root`, `/fd`, `/maps` to the agent. Beyond
the environ leak, this reveals orchestrator command lines (possibly carrying tokens on
argv), open fds, and the host layout of granted vs ungranted paths — reconnaissance for
targeting resources outside the grant. (Verifiers split on whether `/proc/<pid>/fd`
magic-symlinks yield an actual cross-mount file read inside the bwrap mount namespace;
the reliable impact is metadata/path-string disclosure.)

**Fix** — resolved by the same `--unshare-pid` change.

---

## 6. MEDIUM — `resolveNpmEntry` is a second writable-`node_modules` → code-exec sink

**`src/builtins/tools/mcp.ts:260-293`**

`resolveNpmEntry` resolves an MCP server's `npm` package via `createRequire` anchored
at the **manifest dir first**, falling back to Loom's own `node_modules`. Loading then
spawns `node <resolvedEntry>` (StdioClientTransport) unsandboxed with inherited env.
Same trust violation as #2 but a **distinct code path** — fixing `loader.ts` does not
cover it. Re-run at every subagent boot via `runAgent → mcpServerToolsFactory.create`.

**Exploit** — write `<manifestDir>/node_modules/<npmName>/{package.json,entry.js}`
within the default cwd write grant, then `spawn_subagent` against a sub-manifest that
declares an `npm` MCP server → planted entry executes as `node …` outside any sandbox.

> Split verdict (2 real / 1 refuted). One verifier correctly **refuted the headline
> self-copy path**: `cloneManifestWithoutSpawnSubagent` sets `manifestPath =
> <self-copy:…>`, whose `dirname` is garbage, so `createRequire` there throws. The
> **working variant requires a granted *inline* sub-manifest declaring an npm MCP
> server** (author-chosen, not default). The third verifier argued it's the
> out-of-scope supply-chain boundary since the agent only writes within its own grant.
> Worth fixing alongside #2 regardless.

**Fix** — resolve MCP `npm` servers only from a trusted, non-agent-writable root, or
refuse packages whose resolved path is under any agent-writable grant. Apply the same
hardening chosen for #2.

---

## Unconfirmed — worth a manual look

These got only 1/3 verifier votes (the skeptics judged them speculative), but the
underlying soundness concern is plausible and cheap to check:

- **Subagent ceiling check uses the wrong algebra for non-native tools.**
  `assertSubagentCeiling` (`ceiling.ts:75-104`) probes via `probeTool`
  (`tool-groups.ts:362-375`) against the **native registry only**
  (`native.ts:66-84`). If provider/MCP/renamed tools fall back to `defaultContains`
  instead of the tool's own `containsGrant`, the subagent ceiling enforcement could be
  unsound for exactly the tools that define custom capability algebras. Verify that
  `probeTool` resolves a provider/MCP tool's real `containsGrant`, not the default.

---

## Coverage

13 domain finders read the real code across: sandbox (macOS `sandbox-exec`, Linux
`bwrap`), the network broker/shim, capability lattice
(`containsGrant`/`mergeGrants`/ceiling/property-check), path tools, manifest
parsing + env substitution, secrets, MCP tool filtering, provider loading, ACP +
permissions, subagents, harnesses + web_search, plus a cross-cutting critic. No
confirmed issues were found in: the macOS sandbox profile generation, the broker
whitelist/socket protocol, the capability lattice algebra itself, env substitution,
secret storage, or ACP — these areas appear sound against the agent threat model.
