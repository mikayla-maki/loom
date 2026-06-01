import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import type { CapabilitySet } from "../../types/manifest.js";

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

export function sandboxEngaged(grant: CapabilitySet): boolean {
  return grant !== "*";
}

export function validateBashGrant(grant: CapabilitySet): void {
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

export async function buildBashProfile(grant: CapabilitySet): Promise<string> {
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
  }

  return lines.join("\n") + "\n";
}

function escapeSbpl(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

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
