/**
 * macOS `sandbox-exec` wrapper.
 *
 * `sandbox-exec` is a system binary (`/usr/bin/sandbox-exec`) that
 * runs a child process under a Sandbox Profile Language (SBPL)
 * profile. Apple deprecated it as a stable interface in 2017 but it
 * still works on current macOS and is the most pragmatic option for
 * sandboxing a CLI subprocess. Chromium, Firefox, and other tools use
 * the same path.
 *
 * Profile shape (SBPL is a Scheme dialect):
 *
 *   (version 1)
 *   (deny default)
 *   (allow process-fork)
 *   (allow process-exec*)
 *   (allow file-read* (subpath "/abs/path"))
 *   (allow file-write* (subpath "/abs/path"))
 *   (allow network*)
 *   (allow signal (target self))    ; needed for child to exit cleanly
 *   ...
 *
 * We generate the profile from a Loom CapabilitySet at spawn time;
 * the same JSON that drives the description and the runtime
 * self-policing also drives the OS-level enforcement.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import type { CapabilitySet } from "../../types/manifest.js";

const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/**
 * Whether `sandbox-exec` is available at its canonical path. Cached
 * after first check (the binary doesn't appear or disappear during a
 * Loom session).
 */
let sandboxExecAvailable: boolean | null = null;

export async function hasSandboxExec(): Promise<boolean> {
  if (sandboxExecAvailable !== null) return sandboxExecAvailable;
  if (process.platform !== "darwin") {
    sandboxExecAvailable = false;
    return false;
  }
  try {
    await fs.access(SANDBOX_EXEC_PATH, fs.constants.X_OK);
    sandboxExecAvailable = true;
  } catch {
    sandboxExecAvailable = false;
  }
  return sandboxExecAvailable;
}

/** Reset the cache. Test-only. */
export function _resetSandboxExecCache(): void {
  sandboxExecAvailable = null;
}

/**
 * Whether the grant should engage the sandbox. `"*"` opts out
 * (whole-tool unrestricted = no enforcement); a structured grant
 * means the user is asking for enforcement.
 */
export function sandboxEngaged(grant: CapabilitySet): boolean {
  return grant !== "*";
}

/**
 * Validate that a grant uses only value shapes the macOS sandbox can
 * actually enforce. Throws when the user wrote something like
 * `network = ["example.com"]` — the cap-validator only checked the
 * KIND was known, not that we can deliver on the value. Reject loudly
 * at boot so the user fixes the manifest rather than thinking they've
 * sandboxed something they haven't.
 *
 * `"*"` whole-tool grants are exempt (caller will skip the sandbox
 * entirely; nothing to enforce, nothing to reject).
 */
export function validateBashGrant(grant: CapabilitySet): void {
  if (grant === "*") return;

  // subprocess: only "*" supported. An exec-allowlist would need
  // distinct (allow process-exec (literal ...)) per binary, plus more
  // careful PATH handling. Future work; reject for now.
  const sp = grant.subprocess;
  if (sp !== undefined && sp !== "*") {
    throw new Error(
      `bash: capabilities.subprocess only supports "*" on macOS (sandbox-exec ` +
        `cannot enforce an exec allowlist). Got ${JSON.stringify(sp)}.`,
    );
  }

  // paths: "*" or string array.
  const p = grant.paths;
  if (p !== undefined && p !== "*") {
    if (!Array.isArray(p) || !p.every((x) => typeof x === "string")) {
      throw new Error(
        `bash: capabilities.paths must be "*" or an array of strings. ` +
          `Got ${JSON.stringify(p)}.`,
      );
    }
  }

  // network: only "*" or [] supported. sandbox-exec lacks per-host
  // filtering so a host allowlist would silently degrade to either
  // "open" or "closed" — reject explicitly so the user notices.
  const net = grant.network;
  if (net !== undefined && net !== "*") {
    if (!Array.isArray(net) || net.length !== 0) {
      throw new Error(
        `bash: capabilities.network must be "*" (allow all) or [] (deny all) on ` +
          `macOS. Per-host filtering is not supported by sandbox-exec. ` +
          `Got ${JSON.stringify(net)}.`,
      );
    }
  }

  // env: "*" or string array (handled by buildEnv at spawn time;
  // validate the shape here so it's caught at boot).
  const env = grant.env;
  if (env !== undefined && env !== "*") {
    if (!Array.isArray(env) || !env.every((x) => typeof x === "string")) {
      throw new Error(
        `bash: capabilities.env must be "*" or an array of strings. ` +
          `Got ${JSON.stringify(env)}.`,
      );
    }
  }
}

/**
 * Build an SBPL profile from a structured CapabilitySet.
 *
 * Kinds we translate:
 *   subprocess: star    → allow process-fork + process-exec
 *   subprocess: list    → rejected by validateBashGrant
 *   paths: star         → allow file-read + file-write (entire FS)
 *   paths: list         → allow file-read and file-write per (subpath ...)
 *   network: star       → allow network
 *   network: list       → rejected by validateBashGrant
 *   network: absent/[]  → no rules emitted (denied by default-deny)
 *
 * Always-on rules that bash needs to function under the sandbox:
 *   - signal to self (clean process exit)
 *   - sysctl-read (uname-style introspection)
 *   - mach-lookup for common system services
 *   - file-read-metadata broadly — stat-style access for getcwd(),
 *     ls's path display, $PWD lookups, etc. Metadata is
 *     existence/size/permissions/dir-entries; file CONTENTS still
 *     require the more specific file-read* rules. Without this,
 *     bash prints "shell-init: getcwd: cannot access parent
 *     directories" on every command.
 *   - file-read for /usr, /System, /Library (system libraries),
 *     /private/etc (resolv.conf, hosts), /dev (terminal, /dev/null)
 *   - file-read on (literal "/") — bash stats / during cwd resolution
 *   - file-read on /private/tmp + /private/var/folders — TMPDIR contents
 *   - file-read on /Applications — macOS installs developer tooling
 *     here (Xcode.app, Xcode CLT shims). `python3` and other tools
 *     that go through xcrun fail to dlopen libxcrun.dylib without
 *     access here.
 *   - file-read on /opt — Homebrew lives at /opt/homebrew on Apple
 *     Silicon. User-installed CLI tools (rg, jq, deno, …) live there.
 *   - file-read on ~/.gitconfig and ~/.config/git — git refuses to
 *     run any command (even `git init`) without being able to read
 *     the user's global config. Restricted to the specific git
 *     paths only; other dotfiles (~/.zshrc, ~/.aws, ~/.ssh, etc.)
 *     remain inaccessible. Read-only on purpose: the agent can use
 *     `git -c key=value` or local config to override per-repo, but
 *     it shouldn't mutate the user's global git state.
 *
 * The "allow defaults" set keeps bash itself working: without these,
 * even `/bin/bash -c echo` fails on dyld lookups or cwd resolution.
 * They do not grant user-data access; they are the standard "let
 * processes run at all" baseline that Apple's own Application
 * sandbox starts from.
 *
 * Async because path canonicalization (`fs.realpath`) is async; we
 * have to follow symlinks before embedding paths in `(subpath ...)`
 * rules — the kernel matches against the canonical path, not the
 * symlink-laden form. macOS `/var → /private/var` is the canonical
 * gotcha: a `(subpath "/var/...")` rule never fires because the
 * kernel view is `/private/var/...`.
 */
export async function buildBashProfile(grant: CapabilitySet): Promise<string> {
  if (grant === "*") {
    throw new Error(
      'buildBashProfile: "*" grant means no sandbox; check sandboxEngaged() first',
    );
  }
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    // Process control needed for the bash itself to live + die.
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    // Metadata reads everywhere — needed for getcwd() to walk up
    // the directory tree and for ls to display paths. File
    // CONTENTS still require the file-read* rules below; this is
    // strictly stat-style access (names, sizes, permissions).
    "(allow file-read-metadata)",
    // Stat the filesystem root — bash hits this during cwd lookup
    // before any user command runs. Without it bash exits with SIGABRT.
    '(allow file-read* (literal "/"))',
    // Read system libraries and config — without these, dyld can't
    // even load /bin/bash, and bash can't read termios info etc.
    '(allow file-read* (subpath "/usr"))',
    '(allow file-read* (subpath "/System"))',
    '(allow file-read* (subpath "/Library"))',
    '(allow file-read* (subpath "/private/etc"))',
    '(allow file-read* (subpath "/private/var/db"))',
    '(allow file-read* (subpath "/private/var/folders"))', // TMPDIR
    '(allow file-read* (subpath "/private/tmp"))',
    '(allow file-read* (subpath "/dev"))',
    '(allow file-write* (subpath "/dev"))', // /dev/null, /dev/tty, ...
    '(allow file-read* (subpath "/bin"))',
    '(allow file-read* (subpath "/sbin"))',
    // Developer tooling paths. Without /Applications, xcrun can't
    // load libxcrun.dylib from Xcode.app and `python3` (a shim that
    // goes through xcrun) fails before it starts. /opt covers
    // Homebrew on Apple Silicon.
    '(allow file-read* (subpath "/Applications"))',
    '(allow file-read* (subpath "/opt"))',
  ];

  // User-state read-only carve-outs. Strictly tool-config paths the
  // agent legitimately needs; NOT a general home-dir grant.
  const home = os.homedir();
  if (home) {
    // Git refuses to run without reading global config; ~/.gitconfig
    // and ~/.config/git are user identity, not secrets.
    lines.push(
      `(allow file-read* (literal "${escapeSbpl(nodePath.join(home, ".gitconfig"))}"))`,
    );
    lines.push(
      `(allow file-read* (subpath "${escapeSbpl(nodePath.join(home, ".config", "git"))}"))`,
    );
  }

  // subprocess
  if (grant.subprocess === "*") {
    lines.push("(allow process-exec*)");
  }
  // (Allowlist subprocess support is future work — sandbox-exec can
  //  match exec by literal path, but the UX needs more thought.)

  // paths — read+write for everything in the grant. SBPL `(subpath ...)`
  // matches against the kernel's canonical view of paths, so we have to
  // resolve relative entries against process.cwd() AND follow symlinks.
  // macOS bites us specifically on `/var → /private/var` and on tmpdir
  // paths under `/var/folders/…` which kernel-side are
  // `/private/var/folders/…`. canonicalPath() handles both.
  const p = grant.paths;
  if (p === "*") {
    lines.push("(allow file-read*)");
    lines.push("(allow file-write*)");
  } else if (Array.isArray(p)) {
    for (const root of p) {
      if (typeof root !== "string") continue;
      const abs = await canonicalPath(root);
      lines.push(`(allow file-read*  (subpath "${escapeSbpl(abs)}"))`);
      lines.push(`(allow file-write* (subpath "${escapeSbpl(abs)}"))`);
    }
  }
  // paths absent: denied by `(deny default)`. (No "smart default" at
  // the sandbox level — the bash tool's smart default for paths is
  // expressed in the description, not the profile.)

  // network
  if (grant.network === "*") {
    lines.push("(allow network*)");
  }
  // (Per-host filtering: sandbox-exec doesn't really do it. We could
  //  emit `(allow network* (remote ip "*:443"))` for ports but not
  //  hosts. Skip for now; document the limitation.)

  return lines.join("\n") + "\n";
}

/** Escape a path for embedding in an SBPL string literal. */
function escapeSbpl(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Resolve `p` to an absolute path AND follow symlinks all the way down,
 * so the result is the kernel's canonical view. Falls back to
 * `path.resolve` when the path doesn't exist yet (the sandbox rule
 * still works for paths created later, as long as they're not under a
 * symlinked parent we couldn't observe).
 *
 * Recurses on the parent when realpath fails with ENOENT — so a grant
 * for `<scratch>/logs` where `logs/` doesn't exist canonicalises
 * `<scratch>` and re-appends `logs`.
 */
async function canonicalPath(p: string): Promise<string> {
  const abs = nodePath.resolve(p);
  try {
    return await fs.realpath(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return abs;
    const parent = nodePath.dirname(abs);
    if (parent === abs) return abs; // hit root
    const canonicalParent = await canonicalPath(parent);
    return nodePath.join(canonicalParent, nodePath.basename(abs));
  }
}

/**
 * Spawn arguments that engage sandbox-exec, when the platform supports
 * it and the grant is structured. Returns:
 *   - `{ binary, prefixArgs }` — caller spawns `binary` with
 *     `[...prefixArgs, ...originalArgs]`. Use this when sandboxing is
 *     active.
 *   - `null` — no sandboxing should be applied (either grant is `"*"`
 *     or the platform doesn't support it). Caller spawns normally.
 */
export async function maybeSandboxExecPrefix(
  grant: CapabilitySet,
): Promise<{ binary: string; prefixArgs: string[] } | null> {
  if (!sandboxEngaged(grant)) return null;
  if (!(await hasSandboxExec())) return null;
  const profile = await buildBashProfile(grant);
  return {
    binary: SANDBOX_EXEC_PATH,
    prefixArgs: ["-p", profile, "--"],
  };
}
