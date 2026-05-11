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

import { runAgent } from "../sdk/run-agent.js";
import { TextRenderer } from "./renderer.js";
import { auditAgent, formatCapabilityTree } from "../audit/audit.js";
import { ttyPermissionHandler } from "./permissions.js";
import { ttyMissingSecretHandler } from "./secret-prompt.js";
import { runRepl } from "./repl.js";
import { ansi } from "./markdown.js";
import { wantsColor } from "./term.js";
import type { AuditFinding } from "../types/interfaces.js";

/**
 * Runtime audit findings from `Tool.audit()` get printed to stderr
 * with severity-colored icons. Errors don't reach this hook — they
 * throw at boot — so we only see ok / warning here.
 */
function stderrAuditPrinter() {
  const color = wantsColor();
  const dim = color ? "\x1b[2m" : "";
  const yellow = color ? "\x1b[33m" : "";
  const reset = color ? "\x1b[0m" : "";
  return (f: AuditFinding & { tool: string }): void => {
    if (f.severity === "warning") {
      process.stderr.write(`${yellow}⚠${reset} ${f.tool}: ${f.message}\n`);
      if (f.remediation) {
        process.stderr.write(`  ${dim}→ ${f.remediation}${reset}\n`);
      }
    }
    // ok findings are silent at the CLI; visible via `loom audit`.
  };
}

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
    case "providers":
      return await cmdProviders(argv.slice(1));
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
  loom run <agent.toml>                  Interactive REPL with the agent.
  loom prompt <agent.toml> [text]        One-shot prompt (stdin if [text] omitted).
  loom audit <agent.toml> [--strict] [--json]
                                         Print the static capability tree.
  loom acp serve <agent.toml>            Speak ACP over stdio.
  loom install [agent.toml]              Install the manifest's deps (npm + path sources).
  loom install --frozen [agent.toml]     Refuse if lock.toml is missing or stale (CI).
  loom providers list                    List Loom provider npm packages on disk.
  loom providers info <name>             Show resolved metadata for a provider package.

ANSI styling tracks the COLORTERM env var — unset COLORTERM for plain
output. Agent thought chunks are always shown.

In the REPL: tab to complete /commands. Built-ins:
  /quit /exit /help /audit /events [N] /tools
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
  const plain = !wantsColor();
  const agent = await runAgent(manifestPath, {
    permissionHandler: ttyPermissionHandler(),
    onMissingSecret: ttyMissingSecretHandler(),
    onAuditFinding: stderrAuditPrinter(),
  });
  try {
    await runRepl({
      agent,
      plain,
      banner: buildRunBanner(agent.manifest.name, plain),
    });
  } finally {
    await agent.close();
  }
  return 0;
}

function buildRunBanner(agentName: string, plain: boolean): string {
  if (plain)
    return `loom run — ${agentName}\n(/help for commands; ctrl-c to quit)\n`;
  return (
    `${ansi.bold}${ansi.cyan}loom${ansi.reset} ${ansi.dim}run —${ansi.reset} ${ansi.bold}${agentName}${ansi.reset}\n` +
    `${ansi.dim}(${ansi.reset}/help${ansi.dim} for commands; ctrl-c to quit)${ansi.reset}\n`
  );
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
    onMissingSecret: ttyMissingSecretHandler(),
    onAuditFinding: stderrAuditPrinter(),
  });
  const renderer = new TextRenderer();
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
    console.error("usage: loom audit <agent.toml> [--json] [--strict]");
    return 2;
  }
  // Colours track COLORTERM — callers unset it to get plain output
  // when piping.
  const color = wantsColor();
  try {
    const tree = await auditAgent(manifestPath, {
      strict: !!opts.flags.strict,
    });
    if (opts.flags.json) {
      process.stdout.write(JSON.stringify(tree, null, 2) + "\n");
    } else {
      process.stdout.write(formatCapabilityTree(tree, { color }) + "\n");
    }
    return 0;
  } catch (e) {
    console.error(`loom audit: ${(e as Error).message}`);
    return 1;
  }
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
  // serveOverStdio waits for `initialize`, then constructs the agent
  // with the negotiated client capabilities. The CLI just supplies
  // the manifest path and lets the server own the lifecycle.
  await serveOverStdio(manifestPath, {
    onMissingSecret: ttyMissingSecretHandler(),
  });
  return 0;
}

async function cmdProviders(args: string[]): Promise<number> {
  const sub = args[0];
  const { listInstalledProviders, locateProviderPackage } =
    await import("../providers/loader.js");
  if (sub === "list") {
    const items = await listInstalledProviders({});
    if (items.length === 0) {
      process.stdout.write(
        "(no Loom provider packages found in node_modules, npm root -g, or ~/.loom/providers)\n",
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
      console.error("usage: loom providers info <name>");
      return 2;
    }
    try {
      const info = await locateProviderPackage(name, {
        agentManifestDir: process.cwd(),
      });
      process.stdout.write(JSON.stringify(info, null, 2) + "\n");
      return 0;
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
  }
  console.error("usage: loom providers <list|info> [name]");
  return 2;
}

/**
 * `loom install` — install the manifest's declared deps (npm + path
 * sources). Delegates to `cli/install.ts`.
 */
async function cmdInstall(args: string[]): Promise<number> {
  const opts = parseFlags(args);
  const manifestPath = opts._[0] ?? "agent.toml";
  const { installManifest } = await import("./install.js");
  try {
    const result = await installManifest(manifestPath, {
      frozen: !!opts.flags.frozen,
    });
    if (result.sources.length === 0) {
      process.stdout.write(
        "nothing to install (manifest uses only builtins).\n",
      );
    } else {
      process.stdout.write(
        `installed ${result.sources.length} source(s) into ${result.loomDir}\n`,
      );
      for (const s of result.sources) {
        const ver = s.resolved ? ` (resolved: ${s.resolved})` : "";
        process.stdout.write(`  - ${s.spec}${ver}\n`);
      }
    }
    return 0;
  } catch (e) {
    console.error(`loom install: ${(e as Error).message}`);
    return 1;
  }
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
