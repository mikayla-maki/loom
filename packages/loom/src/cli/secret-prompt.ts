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
    if (!inp.isTTY) return null; // non-TTY (piped/tests) must not block on input
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
