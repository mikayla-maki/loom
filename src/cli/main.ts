#!/usr/bin/env node
/**
 * Loom CLI — `loom <subcommand>`.
 *
 * Subcommands:
 *   run <agent.toml>           Drive the agent in a REPL loop.
 *   prompt <agent.toml> [text] One-shot: prompt with `text` (or stdin) and exit.
 *   audit <agent.toml>         Print the static capability tree.
 *   acp serve <agent.toml>     Speak ACP over stdio (peer can drive turns).
 *
 * The CLI is intentionally minimal — the surface area is the SDK.
 */

import * as readline from "node:readline";
import { runAgent } from "../sdk/run-agent.js";
import { TextRenderer } from "./renderer.js";
import { auditAgent, formatCapabilityTree } from "../audit/audit.js";
import { ttyPermissionHandler } from "./permissions.js";

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return 0;
  }
  switch (cmd) {
    case "run":
      return await cmdRun(argv.slice(1));
    case "prompt":
      return await cmdPrompt(argv.slice(1));
    case "audit":
      return await cmdAudit(argv.slice(1));
    case "acp":
      return await cmdAcp(argv.slice(1));
    case "install":
      return await cmdInstall(argv.slice(1));
    case "list":
      return await cmdList(argv.slice(1));
    case "extensions":
      return await cmdExtensions(argv.slice(1));
    default:
      console.error(`Unknown subcommand: ${cmd}`);
      printHelp();
      return 2;
  }
}

function printHelp(): void {
  process.stdout.write(
    `loom — manifest-driven agent meta-harness

Usage:
  loom run <agent.toml>                  Start an interactive REPL.
  loom prompt <agent.toml> [text]        One-shot prompt (stdin if [text] omitted).
  loom audit <agent.toml>                Print the static capability tree.
  loom acp serve <agent.toml>            Speak ACP over stdio.
  loom install <kind> <path> [--name N]  Install a skill/tool/agent into ~/.loom.
  loom list <kind>                       List installed skills/tools/agents.
  loom extensions list                   List Loom extension npm packages on disk.
  loom extensions info <name>            Show resolved metadata for an extension package.

Where <kind> ∈ { skill | tool | agent }.

Flags:
  --no-colors                             Disable ANSI colour output.
  --show-thoughts                         Render agent_thought_chunk updates.
`,
  );
}

async function cmdRun(args: string[]): Promise<number> {
  const opts = parseFlags(args);
  const manifestPath = opts._[0];
  if (!manifestPath) {
    console.error("usage: loom run <agent.toml>");
    return 2;
  }
  const agent = await runAgent(manifestPath, {
    permissionHandler: ttyPermissionHandler(),
  });
  const renderer = new TextRenderer({
    useColors: !opts.flags["no-colors"],
    showThoughts: !!opts.flags["show-thoughts"],
  });

  // Background: stream updates.
  const sub = agent.updates();
  (async () => {
    for await (const u of sub) renderer.render(u);
  })();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  process.stdout.write(
    `\nloom: ready (${agent.resolved.source.name}). type a message; ctrl-c to quit.\n`,
  );

  const ask = () =>
    new Promise<string | null>((resolve) => {
      rl.question("> ", (answer) => resolve(answer));
      rl.once("close", () => resolve(null));
    });

  try {
    while (true) {
      const line = await ask();
      if (line === null) break;
      if (!line.trim()) continue;
      try {
        await agent.prompt(line);
      } catch (e) {
        console.error(`error: ${(e as Error).message}`);
      }
    }
  } finally {
    rl.close();
    await agent.close();
  }
  return 0;
}

async function cmdPrompt(args: string[]): Promise<number> {
  const opts = parseFlags(args);
  const manifestPath = opts._[0];
  if (!manifestPath) {
    console.error("usage: loom prompt <agent.toml> [text]");
    return 2;
  }
  let text = opts._.slice(1).join(" ");
  if (!text) text = await readStdin();
  if (!text.trim()) {
    console.error(
      "error: no prompt text supplied (pipe via stdin or pass as arg)",
    );
    return 2;
  }
  const agent = await runAgent(manifestPath, {
    permissionHandler: ttyPermissionHandler(),
  });
  const renderer = new TextRenderer({
    useColors: !opts.flags["no-colors"],
    showThoughts: !!opts.flags["show-thoughts"],
  });
  const sub = agent.updates();
  const consume = (async () => {
    for await (const u of sub) renderer.render(u);
  })();
  try {
    await agent.prompt(text);
  } finally {
    await agent.close();
    await consume.catch(() => undefined);
  }
  return 0;
}

async function cmdAudit(args: string[]): Promise<number> {
  const opts = parseFlags(args);
  const manifestPath = opts._[0];
  if (!manifestPath) {
    console.error("usage: loom audit <agent.toml> [--json]");
    return 2;
  }
  const tree = await auditAgent(manifestPath);
  if (opts.flags.json) {
    process.stdout.write(JSON.stringify(tree, null, 2) + "\n");
  } else {
    process.stdout.write(formatCapabilityTree(tree) + "\n");
  }
  return 0;
}

async function cmdAcp(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub !== "serve") {
    console.error("usage: loom acp serve <agent.toml>");
    return 2;
  }
  const manifestPath = args[1];
  if (!manifestPath) {
    console.error("usage: loom acp serve <agent.toml>");
    return 2;
  }
  const { serveOverStdio } = await import("../acp/server.js");
  const agent = await runAgent(manifestPath);
  await serveOverStdio(agent);
  return 0;
}

async function cmdExtensions(args: string[]): Promise<number> {
  const sub = args[0];
  const { listInstalledExtensions, locateExtensionPackage } =
    await import("../extensions/loader.js");
  if (sub === "list") {
    const items = await listInstalledExtensions({});
    if (items.length === 0) {
      process.stdout.write(
        "(no Loom extension packages found in node_modules, npm root -g, or ~/.loom/extensions)\n",
      );
      return 0;
    }
    for (const e of items) {
      const head = e.version ? `${e.name}@${e.version}` : e.name;
      process.stdout.write(`${head}\n`);
      if (e.description) process.stdout.write(`  ${e.description}\n`);
      process.stdout.write(`  ${e.entryPath}\n`);
    }
    return 0;
  }
  if (sub === "info") {
    const name = args[1];
    if (!name) {
      console.error("usage: loom extensions info <name>");
      return 2;
    }
    try {
      const info = await locateExtensionPackage(name, {
        agentManifestDir: process.cwd(),
      });
      process.stdout.write(JSON.stringify(info, null, 2) + "\n");
      return 0;
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
  }
  console.error("usage: loom extensions <list|info> [name]");
  return 2;
}

async function cmdInstall(args: string[]): Promise<number> {
  const opts = parseFlags(args);
  const kind = opts._[0];
  const src = opts._[1];
  if (!kind || !src) {
    console.error(
      "usage: loom install <skill|tool|agent> <path> [--name <name>] [--symlink]",
    );
    return 2;
  }
  if (kind !== "skill" && kind !== "tool" && kind !== "agent") {
    console.error(`unknown kind: ${kind}`);
    return 2;
  }
  const { LocalRegistry } = await import("../registry/registry.js");
  const reg = new LocalRegistry();
  const dest = await reg.install(kind, src, {
    ...(typeof opts.flags.name === "string" ? { name: opts.flags.name } : {}),
    symlink: !!opts.flags.symlink,
  });
  process.stdout.write(`installed ${kind} → ${dest}\n`);
  return 0;
}

async function cmdList(args: string[]): Promise<number> {
  const kind = args[0];
  if (kind !== "skill" && kind !== "tool" && kind !== "agent") {
    console.error("usage: loom list <skill|tool|agent>");
    return 2;
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const home = process.env.LOOM_HOME ?? path.join(os.homedir(), ".loom");
  const dir = path.join(
    home,
    kind === "skill" ? "skills" : kind === "tool" ? "tools" : "agents",
  );
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .sort();
  } catch {
    entries = [];
  }
  if (entries.length === 0) {
    process.stdout.write(`(no installed ${kind}s under ${dir})\n`);
    return 0;
  }
  for (const e of entries) process.stdout.write(`${e}\n`);
  return 0;
}

function parseFlags(args: string[]): {
  _: string[];
  flags: Record<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { _: positional, flags };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
