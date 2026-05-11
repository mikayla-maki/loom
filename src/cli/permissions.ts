/**
 * Tty-driven PermissionHandler for the CLI.
 *
 * Prints the permission request (and its available options) to
 * stderr, prompts on stdin, and returns the corresponding ACP
 * `RequestPermissionResponse`. Options are 1-indexed in the UI to
 * keep the prompt friendly; the optionId selected is the SDK's
 * canonical `optionId` string.
 *
 * If stdin is not a TTY (piped, tests) the handler returns a
 * "cancelled" outcome — same secure default as no handler at all.
 */

import * as readline from "node:readline";

import type {
  PermissionHandler,
  RequestPermissionRequest,
  RequestPermissionResponse,
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
  return async (
    req: Omit<RequestPermissionRequest, "sessionId">,
  ): Promise<RequestPermissionResponse> => {
    if (!inp.isTTY) {
      out.write("\n[permission] cancelled — stdin is not a TTY\n");
      return { outcome: { outcome: "cancelled" } };
    }
    out.write(formatRequest(req));
    const options = req.options;
    options.forEach((o, i) => {
      out.write(`  ${i + 1}) ${o.name} [${o.kind}]\n`);
    });
    out.write(`Select option [1-${options.length}] (or c to cancel): `);
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
    if (answer === "c" || answer === "cancel") {
      return { outcome: { outcome: "cancelled" } };
    }
    const idx = parseInt(answer, 10);
    const choice = !Number.isNaN(idx) ? options[idx - 1] : undefined;
    if (!choice) {
      return { outcome: { outcome: "cancelled" } };
    }
    return { outcome: { outcome: "selected", optionId: choice.optionId } };
  };
}

function formatRequest(
  req: Omit<RequestPermissionRequest, "sessionId">,
): string {
  const lines: string[] = ["", "─── permission request ───"];
  lines.push(`tool: ${req.toolCall.title ?? req.toolCall.toolCallId}`);
  if (req.toolCall.kind) lines.push(`kind: ${req.toolCall.kind}`);
  if (req.toolCall.rawInput) {
    lines.push(`input: ${JSON.stringify(req.toolCall.rawInput)}`);
  }
  return lines.join("\n") + "\n";
}
