/**
 * Tty-driven prompt for resolving missing secrets at agent boot.
 *
 * Surfaces a single line per missing secret and reads the value from
 * stdin (no echo would be ideal, but readline doesn't expose a
 * portable secret-input mode; we just read the line). If stdin isn't a
 * TTY (piped, tests) we return null so the existing `SecretError` path
 * runs and the caller sees a clean failure message instead of hanging
 * waiting for input.
 *
 * Optional secrets prompt with a `[skip]` hint and accept an empty
 * answer to mean "no, leave it missing".
 */

import * as readline from "node:readline";

import type { OnMissingSecret } from "../sdk/run-agent.js";

export function ttyMissingSecretHandler(
  opts: {
    out?: NodeJS.WritableStream;
    in?: NodeJS.ReadableStream;
  } = {},
): OnMissingSecret {
  const out = opts.out ?? process.stderr;
  const inp = (opts.in ?? process.stdin) as NodeJS.ReadableStream & {
    isTTY?: boolean;
  };
  return async (req) => {
    if (!inp.isTTY) return null;
    const tag = req.required ? "required" : "optional";
    out.write(
      `\n[secret] '${req.name}' is missing (${tag}; needed by ${req.requestedBy})\n`,
    );
    const promptLabel = req.required
      ? `enter value for ${req.name}: `
      : `enter value for ${req.name} (optional, blank to skip): `;
    const rl = readline.createInterface({
      input: inp as NodeJS.ReadableStream,
      output: out,
    });
    const answer = await new Promise<string>((resolve) =>
      rl.question(promptLabel, (a) => {
        rl.close();
        resolve(a ?? "");
      }),
    );
    const trimmed = answer.trim();
    if (trimmed.length === 0) return null;
    return trimmed;
  };
}
