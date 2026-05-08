/**
 * Linux `bwrap` (bubblewrap) wrapper — sketch.
 *
 * Sibling to `sandbox-exec.ts`: same shape (`hasBwrap`,
 * `buildBwrapArgs`, `validateBashGrantLinux`, `maybeBwrapPrefix`),
 * different mechanism. bwrap creates a Linux user/mount/network
 * namespace, mounts a minimal filesystem inside it, and execs the
 * target command — the OS-level isolation primitive on Linux.
 *
 * Status: VERIFIED on Ubuntu 25.10 (OrbStack, aarch64) with the
 * bash-bwrap-integration suite. bash.ts dispatches to this module
 * on linux platforms; the audit() reporter surfaces bwrap presence
 * as ok/error severity. Behaviour quirks worth knowing:
 *
 *   - The namespace root is `tmpfs`. Writes to sibling paths of a
 *     bind mount (e.g. writing to `/parent/sibling.txt` when only
 *     `/parent/granted/` is bind-mounted) succeed locally on the
 *     tmpfs but evaporate when the bash process exits. Confusing
 *     for users probing the boundary, but not a leak.
 *   - DNS is blocked by `--unshare-net` (no resolver in the
 *     namespace). Direct-IP connections also fail because the
 *     namespace has no routable interfaces other than loopback.
 *   - CAP_NET_RAW is dropped, so `ping` and similar fail with
 *     'Operation not permitted' even though the binaries are
 *     available.
 *
 * ─── bwrap argument shape ───────────────────────────────────────────
 *
 *   bwrap \
 *     --ro-bind /usr /usr \
 *     --ro-bind /lib /lib \
 *     --ro-bind /lib64 /lib64 \
 *     --ro-bind /bin /bin \
 *     --ro-bind /sbin /sbin \
 *     --ro-bind /etc /etc \
 *     --proc /proc --dev /dev \
 *     --tmpfs /tmp \
 *     --bind <granted-path> <granted-path>          # per granted path (rw)
 *     --setenv PATH /usr/bin:/bin                    # filtered env
 *     --unshare-net                                  # when no network grant
 *     --new-session \
 *     /bin/bash -c "<command>"
 *
 * Differences from sandbox-exec:
 *   - bwrap doesn't have a "default-deny + allow rules" model. It
 *     constructs a fresh filesystem namespace; whatever isn't
 *     mounted simply doesn't exist. So our model is "build the
 *     mount table from the grant" rather than "emit allow rules."
 *   - Network: --unshare-net cuts the namespace off from the host
 *     network entirely. Per-host filtering isn't a bwrap thing
 *     (you'd need iptables/netns plumbing), so same restriction
 *     as sandbox-exec: only "*" or [] are valid.
 *   - subprocess: bwrap doesn't restrict exec inside the namespace
 *     once it's running. As with sandbox-exec, exec-allowlist is
 *     out of scope.
 */

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type { CapabilitySet } from "../../types/manifest.js";

const BWRAP_CANDIDATES = [
  "/usr/bin/bwrap",
  "/bin/bwrap",
  "/usr/local/bin/bwrap",
];

let bwrapPath: string | null | undefined;

/** Whether `bwrap` is available on the system. Cached after first check. */
export async function hasBwrap(): Promise<boolean> {
  return (await findBwrap()) !== null;
}

/** Resolve the bwrap binary path (or null if not installed). */
export async function findBwrap(): Promise<string | null> {
  if (bwrapPath !== undefined) return bwrapPath;
  if (process.platform !== "linux") {
    bwrapPath = null;
    return null;
  }
  for (const candidate of BWRAP_CANDIDATES) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      bwrapPath = candidate;
      return candidate;
    } catch {
      // try next
    }
  }
  bwrapPath = null;
  return null;
}

/** Test-only cache reset. */
export function _resetBwrapCache(): void {
  bwrapPath = undefined;
}

/**
 * Validate that a grant uses only value shapes the Linux sandbox can
 * actually enforce. Mirrors `validateBashGrant` (darwin) — same
 * star-or-empty restrictions on subprocess and network, since neither
 * sandbox-exec nor bwrap supports those advanced cases.
 *
 * `"*"` whole-tool grants are exempt (no sandbox, nothing to enforce).
 */
export function validateBashGrantLinux(grant: CapabilitySet): void {
  if (grant === "*") return;

  const sp = grant.subprocess;
  if (sp !== undefined && sp !== "*") {
    throw new Error(
      `bash: capabilities.subprocess only supports "*" on Linux (bwrap ` +
        `has no exec allowlist). Got ${JSON.stringify(sp)}.`,
    );
  }

  const p = grant.paths;
  if (p !== undefined && p !== "*") {
    if (!Array.isArray(p) || !p.every((x) => typeof x === "string")) {
      throw new Error(
        `bash: capabilities.paths must be "*" or an array of strings. ` +
          `Got ${JSON.stringify(p)}.`,
      );
    }
  }

  const net = grant.network;
  if (net !== undefined && net !== "*") {
    if (!Array.isArray(net) || net.length !== 0) {
      throw new Error(
        `bash: capabilities.network must be "*" (allow all) or [] (deny ` +
          `all) on Linux. Per-host filtering is not supported by bwrap. ` +
          `Got ${JSON.stringify(net)}.`,
      );
    }
  }

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
 * Build the bwrap CLI argument list from a structured grant. The
 * caller spawns `<bwrap-path>` with these args followed by the
 * command-to-run (`/bin/bash`, `-c`, command).
 *
 * Mount layout:
 *   - `/usr`, `/lib`, `/lib64`, `/bin`, `/sbin`, `/etc` read-only
 *     (system libraries + config; equivalent to sandbox-exec's
 *      `(allow file-read* (subpath "/usr"))` etc.)
 *   - `/proc`, `/dev` mounted from kernel (bwrap helpers)
 *   - `/tmp` as fresh tmpfs (no host /tmp leakage)
 *   - Each granted path bind-mounted read+write
 *
 * Network: `--unshare-net` unless `network = "*"`.
 *
 * Env: not handled here (bash.ts builds the env separately and
 * passes it via spawn options, same as on darwin).
 */
export async function buildBwrapArgs(grant: CapabilitySet): Promise<string[]> {
  if (grant === "*") {
    throw new Error(
      'buildBwrapArgs: "*" grant means no sandbox; check sandboxEngaged() first',
    );
  }
  const args: string[] = [];

  // System libraries + config (read-only). These are the bash-needs-
  // these-to-be-bash baseline.
  const systemRO = ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc"];
  for (const p of systemRO) {
    args.push("--ro-bind-try", p, p);
  }
  args.push("--proc", "/proc");
  args.push("--dev", "/dev");
  args.push("--tmpfs", "/tmp");

  // Toolchain locations the agent likely needs (Linux equivalents of
  // /Applications + /opt on darwin). Read-only.
  args.push("--ro-bind-try", "/opt", "/opt");
  args.push("--ro-bind-try", "/snap", "/snap");
  args.push("--ro-bind-try", "/var/lib/flatpak", "/var/lib/flatpak");

  // Git config carve-out (matches darwin behaviour).
  if (process.env.HOME) {
    const home = process.env.HOME;
    args.push(
      "--ro-bind-try",
      nodePath.join(home, ".gitconfig"),
      nodePath.join(home, ".gitconfig"),
    );
    args.push(
      "--ro-bind-try",
      nodePath.join(home, ".config", "git"),
      nodePath.join(home, ".config", "git"),
    );
  }

  // Granted paths: read+write bind-mounts, canonicalised.
  const p = grant.paths;
  if (p === "*") {
    // Bind-mount the host root read+write. Equivalent to "no FS sandbox."
    args.push("--bind", "/", "/");
  } else if (Array.isArray(p)) {
    for (const root of p) {
      if (typeof root !== "string") continue;
      const abs = await canonicalPath(root);
      args.push("--bind", abs, abs);
    }
  }

  // Network: unshare unless explicitly granted.
  if (grant.network !== "*") {
    args.push("--unshare-net");
  }

  // Standard isolation flags. --unshare-pid would also be nice but
  // breaks bash builtins like `wait`; --unshare-uts is fine.
  args.push("--unshare-uts");
  args.push("--unshare-ipc");
  args.push("--new-session");
  args.push("--die-with-parent");

  return args;
}

/**
 * Spawn arguments that engage bwrap, when bwrap is available and the
 * grant is structured. Returns `null` to signal "run unsandboxed" —
 * the caller falls through to plain spawn (or refuses, depending on
 * policy).
 */
export async function maybeBwrapPrefix(
  grant: CapabilitySet,
): Promise<{ binary: string; prefixArgs: string[] } | null> {
  if (grant === "*") return null;
  const bwrap = await findBwrap();
  if (!bwrap) return null;
  const prefixArgs = await buildBwrapArgs(grant);
  // bwrap separates its own args from the target command with `--`.
  prefixArgs.push("--");
  return { binary: bwrap, prefixArgs };
}

/** Path-canonicalisation helper, identical in spirit to sandbox-exec.ts. */
async function canonicalPath(p: string): Promise<string> {
  const abs = nodePath.resolve(p);
  try {
    return await fs.realpath(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return abs;
    const parent = nodePath.dirname(abs);
    if (parent === abs) return abs;
    const canonicalParent = await canonicalPath(parent);
    return nodePath.join(canonicalParent, nodePath.basename(abs));
  }
}
