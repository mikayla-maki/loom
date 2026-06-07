import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import { expandHome } from "../../internal/util.js";
import type { CapabilityGrant } from "../../types/manifest.js";

// Bash resolves exactly one grant row before any sandbox is constructed.
type SingleRowGrant = "*" | CapabilityGrant;

const BWRAP_CANDIDATES = [
  "/usr/bin/bwrap",
  "/bin/bwrap",
  "/usr/local/bin/bwrap",
];

let bwrapPath: string | null | undefined;

export async function hasBwrap(): Promise<boolean> {
  return (await findBwrap()) !== null;
}

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
      continue;
    }
  }
  bwrapPath = null;
  return null;
}

export function _resetBwrapCache(): void {
  bwrapPath = undefined;
}

export function validateBashGrantLinux(grant: SingleRowGrant): void {
  if (grant === "*") return;

  const c = grant.commands;
  if (c !== undefined && c !== "*") {
    if (
      !Array.isArray(c) ||
      c.length === 0 ||
      !c.every((x) => typeof x === "string" && x.length > 0)
    ) {
      throw new Error(
        `bash: capabilities.commands must be "*" or a non-empty array of ` +
          `command-name strings. Got ${JSON.stringify(c)}.`,
      );
    }
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

export async function buildBwrapArgs(grant: SingleRowGrant): Promise<string[]> {
  if (grant === "*") {
    throw new Error(
      'buildBwrapArgs: "*" grant means no sandbox; check sandboxEngaged() first',
    );
  }
  const args: string[] = [];

  const systemRO = ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc"];
  for (const p of systemRO) {
    args.push("--ro-bind-try", p, p);
  }
  args.push("--proc", "/proc");
  args.push("--dev", "/dev");
  args.push("--tmpfs", "/tmp");

  args.push("--ro-bind-try", "/opt", "/opt");
  args.push("--ro-bind-try", "/snap", "/snap");
  args.push("--ro-bind-try", "/var/lib/flatpak", "/var/lib/flatpak");

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

  const p = grant.paths;
  if (p === "*") {
    args.push("--bind", "/", "/");
  } else if (Array.isArray(p)) {
    for (const root of p) {
      if (typeof root !== "string") continue;
      const abs = await canonicalPath(root);
      args.push("--bind", abs, abs);
    }
  }

  if (grant.network !== "*") {
    args.push("--unshare-net");
  } else {
    // systemd-resolved keeps the real resolv.conf under /run; without it,
    // DNS config is unreadable inside the sandbox.
    args.push("--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve");
    args.push("--ro-bind-try", "/run/resolvconf", "/run/resolvconf");
  }

  // --unshare-pid breaks bash builtins like `wait`, so it is omitted.
  args.push("--unshare-uts");
  args.push("--unshare-ipc");
  args.push("--new-session");
  args.push("--die-with-parent");

  return args;
}

export async function maybeBwrapPrefix(
  grant: SingleRowGrant,
): Promise<{ binary: string; prefixArgs: string[] } | null> {
  if (grant === "*") return null;
  const bwrap = await findBwrap();
  if (!bwrap) return null;
  const prefixArgs = await buildBwrapArgs(grant);
  prefixArgs.push("--");
  return { binary: bwrap, prefixArgs };
}

async function canonicalPath(p: string): Promise<string> {
  const abs = nodePath.resolve(expandHome(p));
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
