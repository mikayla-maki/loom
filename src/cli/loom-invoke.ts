#!/usr/bin/env node
/**
 * loom-invoke — small shim that lets a tool subprocess invoke a subagent
 * via the parent's broker socket.
 *
 * Tools never see the broker socket path or token directly in stdout; they
 * receive them via the `LOOM_INVOKE_TOKEN` and `LOOM_INVOKE_SOCKET` env
 * vars set by ProcessTool when the parent has a LoomServer running. This
 * shim wraps the JSON-RPC `session/prompt { token, scope, prompt }` call
 * so tools don't need to speak the wire protocol themselves.
 *
 * Usage:
 *   echo '{"prompt": "hi child"}' | loom-invoke <scope>
 *   loom-invoke <scope> "hi child"
 *
 * Output: the subagent's final assistant message on stdout. Exit 0 on
 * success; non-zero with stderr message on error.
 */

import { connect } from "node:net";

interface InvokeResult {
  stopReason?: string;
  finalMessage?: string;
}

interface JsonRpcResponse {
  id: number;
  result?: InvokeResult;
  error?: { code: number; message: string };
}

async function readStdinJson(): Promise<{ prompt?: string } | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as { prompt?: string };
  } catch {
    // Treat raw stdin as prompt text.
    return { prompt: text };
  }
}

async function main(argv: string[]): Promise<number> {
  const [scope, ...rest] = argv;
  if (!scope) {
    process.stderr.write(
      "loom-invoke: missing <scope> argument. Usage: loom-invoke <scope> [prompt]\n",
    );
    return 2;
  }

  const token = process.env.LOOM_INVOKE_TOKEN;
  const socketPath = process.env.LOOM_INVOKE_SOCKET;
  if (!token || !socketPath) {
    process.stderr.write(
      "loom-invoke: not running under a Loom broker (LOOM_INVOKE_TOKEN/SOCKET unset).\n",
    );
    return 3;
  }

  const fromStdin = await readStdinJson();
  const fromArg = rest.join(" ");
  const prompt = fromStdin?.prompt ?? fromArg;
  if (!prompt) {
    process.stderr.write(
      "loom-invoke: no prompt supplied (pipe JSON {prompt} on stdin or pass as arg).\n",
    );
    return 2;
  }

  try {
    const result = await callBroker(socketPath, token, scope, prompt);
    process.stdout.write((result.finalMessage ?? "") + "\n");
    return 0;
  } catch (e) {
    process.stderr.write(`loom-invoke: ${(e as Error).message}\n`);
    return 1;
  }
}

function callBroker(
  socketPath: string,
  token: string,
  scope: string,
  prompt: string,
): Promise<InvokeResult> {
  return new Promise<InvokeResult>((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = "";
    let settled = false;
    const finish = (err: Error | null, result?: InvokeResult) => {
      if (settled) return;
      settled = true;
      sock.end();
      if (err) reject(err);
      else resolve(result ?? {});
    };

    sock.once("error", (err) => finish(err));
    sock.once("connect", () => {
      const msg = {
        jsonrpc: "2.0",
        id: 1,
        method: "session/prompt",
        params: { token, scope, prompt },
      };
      sock.write(JSON.stringify(msg) + "\n");
    });
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as JsonRpcResponse;
          if (parsed.id !== 1) continue;
          if (parsed.error) {
            finish(new Error(parsed.error.message));
          } else {
            finish(null, parsed.result);
          }
          return;
        } catch (e) {
          finish(e as Error);
          return;
        }
      }
    });
    sock.once("close", () => {
      finish(new Error("broker closed connection before response"));
    });
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`loom-invoke: ${(e as Error).message}\n`);
    process.exit(1);
  },
);
