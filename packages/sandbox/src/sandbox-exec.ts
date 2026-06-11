import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { expandHome } from "@mcmaki/loom-capabilities";
import type { CapabilityGrant } from "@mcmaki/loom-capabilities";

// Bash resolves exactly one grant row before any sandbox is constructed.
type SingleRowGrant = "*" | CapabilityGrant;

const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

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

export function _resetSandboxExecCache(): void {
  sandboxExecAvailable = null;
}

export function sandboxEngaged(grant: SingleRowGrant): boolean {
  return grant !== "*";
}

export function validateBashGrant(grant: SingleRowGrant): void {
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
        `bash: capabilities.network must be "*" (allow all) or [] (deny all) on ` +
          `macOS. Per-host filtering is not supported by sandbox-exec. ` +
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

// When the outer command may escalate into per-command rows, it needs to
// reach the broker: read the shim dir and connect the (canonicalized) socket.
export interface BrokerAccess {
  socketPath: string;
  readDirs: string[];
}

export async function buildBashProfile(
  grant: SingleRowGrant,
  broker?: BrokerAccess,
): Promise<string> {
  if (grant === "*") {
    throw new Error(
      'buildBashProfile: "*" grant means no sandbox; check sandboxEngaged() first',
    );
  }
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    // Load-bearing for getcwd: a process must be able to stat its working
    // directory (and the broker shim must read its own cwd to forward it).
    // Without this, process.cwd()/`pwd` fail with EPERM in any granted dir
    // whose parents aren't otherwise readable. Do not remove.
    "(allow file-read-metadata)",
    '(allow file-read* (literal "/"))',
    '(allow file-read* (subpath "/usr"))',
    '(allow file-read* (subpath "/System"))',
    '(allow file-read* (subpath "/Library"))',
    '(allow file-read* (subpath "/private/etc"))',
    '(allow file-read* (subpath "/private/var/db"))',
    '(allow file-read* (subpath "/private/var/folders"))',
    '(allow file-read* (subpath "/private/tmp"))',
    '(allow file-read* (subpath "/dev"))',
    '(allow file-write* (subpath "/dev"))',
    '(allow file-read* (subpath "/bin"))',
    '(allow file-read* (subpath "/sbin"))',
    '(allow file-read* (subpath "/Applications"))',
    '(allow file-read* (subpath "/opt"))',
  ];

  const home = os.homedir();
  if (home) {
    lines.push(
      `(allow file-read* (literal "${escapeSbpl(nodePath.join(home, ".gitconfig"))}"))`,
    );
    lines.push(
      `(allow file-read* (subpath "${escapeSbpl(nodePath.join(home, ".config", "git"))}"))`,
    );
  }

  if (grant.commands !== undefined) {
    lines.push("(allow process-exec*)");
  }

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

  if (grant.network === "*") {
    lines.push("(allow network*)");
    // /etc/resolv.conf symlinks to ../var/run/resolv.conf; without this,
    // DNS config is unreadable and every networked lookup times out.
    lines.push('(allow file-read* (subpath "/private/var/run"))');
  }

  if (broker) {
    for (const dir of broker.readDirs) {
      const abs = await canonicalPath(dir);
      lines.push(`(allow file-read* (subpath "${escapeSbpl(abs)}"))`);
    }
    // Unix-socket connect needs the network-outbound rule on the canonical
    // path (the /tmp→/private/tmp symlink defeats a literal otherwise).
    const sock = await canonicalPath(broker.socketPath);
    lines.push(`(allow network-outbound (literal "${escapeSbpl(sock)}"))`);
  }

  return lines.join("\n") + "\n";
}

function escapeSbpl(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

export async function maybeSandboxExecPrefix(
  grant: SingleRowGrant,
  broker?: BrokerAccess,
): Promise<{ binary: string; prefixArgs: string[] } | null> {
  if (!sandboxEngaged(grant)) return null;
  if (!(await hasSandboxExec())) return null;
  const profile = await buildBashProfile(grant, broker);
  return {
    binary: SANDBOX_EXEC_PATH,
    prefixArgs: ["-p", profile, "--"],
  };
}
