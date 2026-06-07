import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { CapabilityGrant } from "../../types/manifest.js";
import { buildEnv } from "../builtins/bash.js";
import { maybeBwrapPrefix } from "./bwrap.js";
import { maybeSandboxExecPrefix, sandboxEngaged } from "./sandbox-exec.js";

// One unix-socket connection per brokered invocation. Frames multiplex the
// streams: [channel:u8][len:u32be][payload]. The shim (running inside the
// outer sandbox) sends REQUEST then STDIN; the broker (on the host) runs the
// command in its own per-command sandbox and streams STDOUT/STDERR/EXIT back.
export const CH_REQUEST = 0;
export const CH_STDIN = 1;
export const CH_STDOUT = 2;
export const CH_STDERR = 3;
export const CH_EXIT = 4;
export const CH_ERROR = 5;

export interface BrokerRequest {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export function encodeFrame(channel: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(channel, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Array<{ channel: number; payload: Buffer }> {
    this.buf =
      this.buf.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buf, chunk]);
    const out: Array<{ channel: number; payload: Buffer }> = [];
    for (;;) {
      if (this.buf.length < 5) break;
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) break;
      const channel = this.buf.readUInt8(0);
      const payload = this.buf.subarray(5, 5 + len);
      out.push({ channel, payload });
      this.buf = this.buf.subarray(5 + len);
    }
    return out;
  }
}

export interface BrokerHandle {
  socketPath: string;
  close(): Promise<void>;
}

// Starts the broker server. `rows` are the per-command grant rows the outer
// command may escalate into — each MUST carry an explicit `commands` array.
export async function startBroker(args: {
  socketPath: string;
  rows: readonly CapabilityGrant[];
}): Promise<BrokerHandle> {
  const { socketPath, rows } = args;
  // The shim lives alongside the socket and is prepended to the outer
  // command's PATH, so a brokered command's own name resolves back to the
  // shim. The inner command must resolve to the real binary, so this dir is
  // stripped from the PATH the broker hands the child.
  const shimDir = path.dirname(socketPath);
  const server = net.createServer((conn) => {
    handleConnection(conn, rows, shimDir).catch(() => conn.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function rowFor(
  rows: readonly CapabilityGrant[],
  command: string,
): CapabilityGrant | undefined {
  return rows.find(
    (row) => Array.isArray(row.commands) && row.commands.includes(command),
  );
}

async function handleConnection(
  conn: net.Socket,
  rows: readonly CapabilityGrant[],
  shimDir: string,
): Promise<void> {
  const decoder = new FrameDecoder();
  let started = false;

  // Spawning the child is async (profile build + sandbox prefix), so STDIN
  // frames — including the empty EOF frame — can arrive before the child
  // exists. Buffer them and flush in order once `start` installs the sink,
  // otherwise a child that reads stdin never sees EOF and hangs.
  let stdinSink: ((chunk: Buffer) => void) | null = null;
  const pendingStdin: Buffer[] = [];
  const pushStdin = (chunk: Buffer): void => {
    if (stdinSink) stdinSink(chunk);
    else pendingStdin.push(chunk);
  };
  const setStdinSink = (sink: (chunk: Buffer) => void): void => {
    stdinSink = sink;
    for (const chunk of pendingStdin) sink(chunk);
    pendingStdin.length = 0;
  };

  const fail = (message: string): void => {
    conn.write(encodeFrame(CH_ERROR, Buffer.from(message, "utf8")));
    conn.end();
  };

  conn.on("data", (chunk: Buffer) => {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch {
      conn.destroy();
      return;
    }
    for (const frame of frames) {
      if (!started) {
        if (frame.channel !== CH_REQUEST) {
          fail("broker: first frame must be a request");
          return;
        }
        started = true;
        void start(conn, frame.payload, rows, shimDir, setStdinSink, fail);
      } else if (frame.channel === CH_STDIN) {
        pushStdin(frame.payload);
      }
    }
  });
}

async function start(
  conn: net.Socket,
  reqPayload: Buffer,
  rows: readonly CapabilityGrant[],
  shimDir: string,
  setStdinSink: (sink: (chunk: Buffer) => void) => void,
  fail: (m: string) => void,
): Promise<void> {
  let req: BrokerRequest;
  try {
    req = JSON.parse(reqPayload.toString("utf8")) as BrokerRequest;
  } catch {
    fail("broker: malformed request");
    return;
  }
  const command = req.argv[0];
  if (!command) {
    fail("broker: empty argv");
    return;
  }
  const row = rowFor(rows, command);
  if (!row) {
    fail(`broker: '${command}' is not a brokered command`);
    return;
  }

  // The broker runs on the host, outside any sandbox: it MUST wrap the child
  // or refuse. Mirrors bash's own unsandboxed-refusal.
  let prefix: { binary: string; prefixArgs: string[] } | null = null;
  if (process.platform === "darwin") {
    prefix = await maybeSandboxExecPrefix(row);
  } else if (process.platform === "linux") {
    prefix = await maybeBwrapPrefix(row);
  }
  if (!prefix && sandboxEngaged(row)) {
    fail(`broker: no sandbox backend available; refusing to run '${command}'`);
    return;
  }

  // Same tier processing as a normal bash invocation, over the host env
  // overlaid with the shim's in-sandbox env: the row can forward both an
  // orchestrator-held secret and a variable the agent set in its shell.
  const env = buildEnv(row, { ...process.env, ...sanitizeEnv(req.env) });
  // SECURITY: resolve the brokered command against the HOST PATH, never the
  // agent's forwarded PATH. Otherwise the agent could drop a binary named
  // after a rowed command into a writable dir, prepend it to PATH, and have
  // the broker run that binary under the command's (elevated) grant. The
  // command name is the unit of authority; it must map to the real,
  // host-installed binary. (This is also why a restrictive env tier, which
  // would drop PATH, must not leave the child unable to resolve the command.)
  env.PATH = stripPathEntry(process.env.PATH ?? "", shimDir);
  // Keep the child's logical PWD aligned with the directory it is spawned
  // in, regardless of whether the row's env tier forwarded PWD.
  env.PWD = req.cwd;
  const binary = prefix ? prefix.binary : command;
  const childArgs = prefix
    ? [...prefix.prefixArgs, command, ...req.argv.slice(1)]
    : req.argv.slice(1);

  const child = spawn(binary, childArgs, {
    cwd: req.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // A command may stop reading stdin early (e.g. `head`); writing to its
  // closed pipe raises EPIPE on the stream, which would otherwise be an
  // unhandled error on the host.
  child.stdin.on("error", () => {});
  setStdinSink((chunk: Buffer) => {
    if (chunk.length === 0) child.stdin.end();
    else child.stdin.write(chunk);
  });

  child.on("error", (e) => fail(`broker: ${(e as Error).message}`));
  child.stdout.on("data", (b: Buffer) => conn.write(encodeFrame(CH_STDOUT, b)));
  child.stderr.on("data", (b: Buffer) => conn.write(encodeFrame(CH_STDERR, b)));
  child.on("close", (code, signal) => {
    // Mirror the shell's convention so signal deaths (segfault, OOM-kill,
    // timeout SIGKILL) propagate as a failure through pipefail and `$?`
    // instead of looking like a clean exit 0.
    const status =
      code != null
        ? code
        : signal
          ? 128 + (os.constants.signals[signal] ?? 0)
          : 0;
    const payload = Buffer.alloc(4);
    payload.writeInt32BE(status, 0);
    conn.write(encodeFrame(CH_EXIT, payload));
    conn.end();
  });
  conn.on("close", () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  });
}

export interface CommandBroker {
  shimDir: string;
  access: { socketPath: string; readDirs: string[] };
  close(): Promise<void>;
}

// Materializes a per-call broker: a temp dir with the shim plus one wrapper
// script per brokered command, a listening socket, and the access the outer
// sandbox needs (shim-dir read + socket connect). Prepend `shimDir` to the
// outer command's PATH so bare invocations resolve to the wrappers.
export async function setupCommandBroker(
  rows: readonly CapabilityGrant[],
): Promise<CommandBroker> {
  // Based in /tmp, not os.tmpdir(): unix socket paths have a ~104-char limit
  // and some TMPDIRs (sandboxed launchers) blow past it. /tmp exists on the
  // only platforms with a sandbox backend. Canonicalize immediately: the
  // shim connects by the exact baked path, and the macOS sandbox matches
  // network-outbound on the literal connect path (no symlink resolution),
  // so connect-path, listen-path, and the sandbox rule must all be the
  // realpath (/tmp → /private/tmp).
  const dir = await fs.realpath(await fs.mkdtemp("/tmp/loom-bk-"));
  const socketPath = path.join(dir, "s.sock");

  // One shebang shim; per-command executable symlinks point at it. The shim
  // reads which command it was invoked as from its own argv[0], so an agent
  // can place these names anywhere on PATH (a pipeline, a python
  // subprocess) and they resolve transparently.
  const shimPath = path.join(dir, "shim");
  await fs.writeFile(shimPath, shimContent(socketPath), { mode: 0o755 });

  const commands = [
    ...new Set(
      rows.flatMap((r) => (Array.isArray(r.commands) ? r.commands : [])),
    ),
  ].filter((c): c is string => typeof c === "string" && !c.includes("/"));

  for (const command of commands) {
    await fs.symlink(shimPath, path.join(dir, command));
  }

  const handle = await startBroker({ socketPath, rows });
  return {
    shimDir: dir,
    access: { socketPath, readDirs: [dir, path.dirname(process.execPath)] },
    close: async () => {
      await handle.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function stripPathEntry(pathValue: string, dir: string): string {
  return pathValue
    .split(path.delimiter)
    .filter((entry) => entry.length > 0 && entry !== dir)
    .join(path.delimiter);
}

function sanitizeEnv(env: unknown): Record<string, string> {
  if (!env || typeof env !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

// The shim, written once per call with the socket path and node path baked
// in. Executable symlinks named after each brokered command point at it; it
// reads the command from `basename(argv[1])` (the symlink it was invoked
// as). CommonJS — no `.mjs` extension means node parses it as CJS — and
// depends only on core. Streams stdin up, stdout/stderr/exit down.
function shimContent(socketPath: string): string {
  return (
    `#!${process.execPath}\n` +
    `const net = require("node:net");\n` +
    `const path = require("node:path");\n` +
    `const SOCK = ${JSON.stringify(socketPath)};\n` +
    `const command = path.basename(process.argv[1]);\n` +
    `const rest = process.argv.slice(2);\n` +
    SHIM_BODY
  );
}

const SHIM_BODY = String.raw`
const conn = net.connect(SOCK);
function frame(channel, payload) {
  const header = Buffer.alloc(5);
  header.writeUInt8(channel, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

// The child should run in the shell's working directory. process.cwd() is
// authoritative and tracks cd, but its getcwd syscall can be denied by the
// OS sandbox when the directory's parent chain isn't readable (bash only
// warns and carries on). Fall back to the shell-exported PWD, which bash
// keeps current across cd and the host seeds canonically.
function shimCwd() {
  try {
    return process.cwd();
  } catch {
    return process.env.PWD || "/";
  }
}

conn.on("connect", () => {
  const req = { argv: [command, ...rest], cwd: shimCwd(), env: process.env };
  conn.write(frame(0, Buffer.from(JSON.stringify(req), "utf8")));
  process.stdin.on("data", (b) => conn.write(frame(1, b)));
  process.stdin.on("end", () => conn.write(frame(1, Buffer.alloc(0))));
});

// Never process.exit(): writes to a piped stdout are async, and exiting
// would truncate unflushed output. Set exitCode and end the socket; node
// exits once stdin/stdout/stderr have drained. Once the child is done, stop
// reading stdin: a flowing stdin keeps the event loop alive forever when
// the upstream never closes it (e.g. the child consumed nothing).
function done() {
  try {
    process.stdin.pause();
    process.stdin.destroy();
  } catch {}
  conn.end();
}
let buf = Buffer.alloc(0);
conn.on("data", (chunk) => {
  buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
  for (;;) {
    if (buf.length < 5) break;
    const len = buf.readUInt32BE(1);
    if (buf.length < 5 + len) break;
    const channel = buf.readUInt8(0);
    const payload = buf.subarray(5, 5 + len);
    buf = buf.subarray(5 + len);
    if (channel === 2) process.stdout.write(payload);
    else if (channel === 3) process.stderr.write(payload);
    else if (channel === 4) {
      process.exitCode = payload.readInt32BE(0);
      done();
    } else if (channel === 5) {
      process.stderr.write(payload.toString("utf8") + "\n");
      process.exitCode = 127;
      done();
    }
  }
});
conn.on("error", (e) => {
  process.stderr.write("shim: " + e.message + "\n");
  process.exitCode = 127;
});
`;
