/**
 * Tty-driven PermissionHandler for the CLI.
 *
 * Prints the permission request to stderr, reads y/n/o (yes-once / yes-session
 * / no) on stdin, and returns the corresponding decision. If stdin is not a
 * TTY (piped, tests) it denies — same secure default as no handler at all.
 */

import * as readline from "node:readline";

import type {
  PermissionDecision,
  PermissionHandler,
  PermissionRequest,
} from "../types/permissions.js";

export function ttyPermissionHandler(
  opts: {
    out?: NodeJS.WritableStream;
    in?: NodeJS.ReadableStream;
  } = {},
): PermissionHandler {
  const out = opts.out ?? process.stderr;
  const inp = (opts.in ?? process.stdin) as NodeJS.ReadableStream & {
    isTTY?: boolean;
  };
  return async (req: PermissionRequest) => {
    if (!inp.isTTY) {
      out.write("\n[permission] denied — stdin is not a TTY\n");
      return { decision: "deny" };
    }
    out.write(formatRequest(req));
    out.write("[a]llow once / [s]ession-allow / [d]eny ? ");
    const rl = readline.createInterface({
      input: inp as NodeJS.ReadableStream,
      output: out,
    });
    const answer = await new Promise<string>((resolve) =>
      rl.question("", (a) => {
        rl.close();
        resolve((a ?? "").trim().toLowerCase());
      }),
    );
    let decision: PermissionDecision = "deny";
    if (answer === "a" || answer === "allow" || answer === "y")
      decision = "allow_once";
    else if (answer === "s" || answer === "session") decision = "allow_session";
    return { decision };
  };
}

function formatRequest(req: PermissionRequest): string {
  const lines: string[] = ["", "─── permission request ───"];
  lines.push(`reason: ${req.reason}`);
  if (req.newCapabilities)
    lines.push(`new capabilities: ${JSON.stringify(req.newCapabilities)}`);
  if (req.metadata) lines.push(`details: ${JSON.stringify(req.metadata)}`);
  return lines.join("\n") + "\n";
}
