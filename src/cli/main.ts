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
import { runPromptCommand, type PromptFormat } from "./prompt.js";
import {
  AuditError,
  auditAgent,
  formatCapabilityTree,
} from "../audit/audit.js";
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
    case "mcp":
      return await cmdMcp(argv.slice(1));
    default:
      console.error(`Unknown subcommand: ${cmd}`);
      printHelp();
      return 2;
  }
}

function printHelp(): void {
  process.stdout.write(
    `loom — A capability-secure, manifest-driven agent runtime.

Usage:
  loom run <agent.toml>                  Interactive REPL with the agent.
  loom prompt <agent.toml> [text] [--format <text|trace|jsonl>]
                                         One-shot prompt (stdin if [text] omitted).
                                         text (default): final agent message to stdout.
                                         trace: coalesced labelled debug view.
                                         jsonl: raw SessionUpdate per line.
  loom audit <agent.toml> [--json]       Print the static capability tree.
                                         Exits non-zero (with partial tree)
                                         if the manifest isn't fully resolved.
  loom acp serve <agent.toml>            Speak ACP over stdio.
  loom install [agent.toml]              Install the manifest's deps (npm + path sources).
  loom install --frozen [agent.toml]     Refuse if lock.toml is missing or stale (CI).
  loom providers list                    List Loom provider npm packages on disk.
  loom providers info <name>             Show resolved metadata for a provider package.
  loom mcp inspect <provider> [--manifest <agent.toml>] [--json]
                                         Dump an MCP server's tools as TOML you can paste.

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
    console.error(
      "usage: loom prompt <agent.toml> [text] [--format <text|trace|jsonl>]",
    );
    return 2;
  }
  const rawFormat =
    typeof opts.flags.format === "string" ? opts.flags.format : "text";
  if (rawFormat !== "text" && rawFormat !== "trace" && rawFormat !== "jsonl") {
    console.error(
      `error: --format must be one of text, trace, jsonl (got "${rawFormat}")`,
    );
    return 2;
  }
  const format = rawFormat as PromptFormat;
  let text = opts._.slice(1).join(" ");
  if (!text) text = await readStdin();
  if (!text.trim()) {
    console.error(
      "error: no prompt text supplied (pipe via stdin or pass as arg)",
    );
    return 2;
  }
  return await runPromptCommand({
    manifest: manifestPath,
    text,
    format,
    permissionHandler: ttyPermissionHandler(),
    onMissingSecret: ttyMissingSecretHandler(),
    onAuditFinding: stderrAuditPrinter(),
  });
}

async function cmdAudit(args: string[]): Promise<number> {
  const opts = parseFlags(args);
  const manifestPath = opts._[0];
  if (!manifestPath) {
    console.error("usage: loom audit <agent.toml> [--json]");
    return 2;
  }
  // Colours track COLORTERM — callers unset it to get plain output
  // when piping.
  const color = wantsColor();
  try {
    const tree = await auditAgent(manifestPath);
    if (opts.flags.json) {
      process.stdout.write(JSON.stringify(tree, null, 2) + "\n");
    } else {
      process.stdout.write(formatCapabilityTree(tree, { color }) + "\n");
    }
    return 0;
  } catch (e) {
    // AuditError carries the partial tree + a structured health
    // summary. Print the tree so the user can see what DID resolve,
    // then the structured error message, then exit non-zero. There
    // is no "lenient" path that returns success with hidden
    // problems — either the manifest is fully resolved or it isn't.
    if (e instanceof AuditError) {
      if (opts.flags.json) {
        process.stdout.write(
          JSON.stringify(
            { tree: e.tree, health: e.health, error: e.message },
            null,
            2,
          ) + "\n",
        );
      } else {
        process.stdout.write(formatCapabilityTree(e.tree, { color }) + "\n");
        const red = color ? "\x1b[31m" : "";
        const reset = color ? "\x1b[0m" : "";
        process.stderr.write(`${red}✖ ${e.message}${reset}\n`);
      }
      return 1;
    }
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
    // Two sections — built-in harness factories (with their
    // server-tool catalogs), then on-disk npm provider packages.
    // The built-ins section is the discoverability path for
    // harness-exposed server tools like Anthropic's `web_search` /
    // `web_fetch`; `loom audit` deliberately doesn't list them per
    // manifest, pointing users here instead.
    await listBuiltinHarnesses();
    const items = await listInstalledProviders({});
    process.stdout.write("\ninstalled provider packages:\n");
    if (items.length === 0) {
      process.stdout.write(
        "  (none found in node_modules, npm root -g, or ~/.loom/providers)\n",
      );
      return 0;
    }
    for (const e of items) {
      const head = e.version ? `${e.name}@${e.version}` : e.name;
      process.stdout.write(`  ${head}\n`);
      if (e.description) process.stdout.write(`    ${e.description}\n`);
      process.stdout.write(`    ${e.entryPath}\n`);
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
 * Print the built-in harness factories registered in the harness
 * registry, plus each one's `availableTools()` catalog (when it
 * implements the optional method). This is where reviewers find
 * out which harness-exposed server tools exist (e.g. Anthropic's
 * `web_search` / `web_fetch`); the per-agent audit deliberately
 * doesn't repeat the catalog on every run.
 *
 * Harness construction needs secrets in principle, but the
 * `availableTools()` catalog is a static / config-only declaration
 * for the built-in factories we ship — so we synthesise stub
 * values for any required-secret slot, the same way `loom audit`
 * does. A construction failure (or a harness without the optional
 * method) is silently treated as "no catalog".
 */
async function listBuiltinHarnesses(): Promise<void> {
  const { listHarnesses, getHarnessFactory } =
    await import("../builtins/index.js");
  const { DEFAULT_CLIENT_ACP_CAPABILITIES } =
    await import("../runtime/acp-capabilities.js");
  const factoryCtx = {
    manifestDir: process.cwd(),
    agentName: "loom-providers-list",
    loomVersion: "cli",
    clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
    storage: process.cwd(),
  };
  const names = listHarnesses().sort();
  process.stdout.write("built-in harnesses:\n");
  for (const name of names) {
    let exposed: string[] = [];
    try {
      const factory = getHarnessFactory(name);
      const stubSecrets: Record<string, string> = {};
      for (const s of factory.secrets?.required ?? []) {
        stubSecrets[s] = "providers-list-stub";
      }
      const harness = await Promise.resolve(
        factory.create(
          /*config*/ {},
          factoryCtx,
          stubSecrets,
          /*parent*/ undefined,
        ),
      );
      const catalog = (await Promise.resolve(harness.availableTools?.())) ?? [];
      exposed = catalog.map((r) => r.name).sort();
    } catch {
      /* construction failed (e.g. requiresParent) — leave empty */
    }
    if (exposed.length > 0) {
      process.stdout.write(`  ${name}\n`);
      process.stdout.write(`    server tools: ${exposed.join(", ")}\n`);
    } else {
      process.stdout.write(`  ${name}\n`);
    }
  }
}

/**
 * `loom mcp <subcmd>` — MCP-related authoring aids. Only `inspect`
 * today.
 */
async function cmdMcp(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub !== "inspect") {
    console.error(
      "usage: loom mcp inspect <provider-spec> [--manifest <agent.toml>] [--json]",
    );
    return 2;
  }
  const opts = parseFlags(args.slice(1));
  const providerSpec = opts._[0];
  if (!providerSpec) {
    console.error(
      "usage: loom mcp inspect <provider-spec> [--manifest <agent.toml>] [--json]",
    );
    return 2;
  }
  const { inspectMcpServer } = await import("./mcp-inspect.js");
  try {
    const result = await inspectMcpServer(providerSpec, {
      ...(typeof opts.flags.manifest === "string"
        ? { manifestPath: opts.flags.manifest }
        : {}),
      json: !!opts.flags.json,
    });
    if (opts.flags.json) {
      process.stdout.write(
        JSON.stringify(
          {
            serverName: result.serverName,
            serverVersion: result.serverVersion,
            launchConfig: result.launchConfig,
            tools: result.tools,
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(result.toml);
    }
    return 0;
  } catch (e) {
    console.error(`loom mcp inspect: ${(e as Error).message}`);
    return 1;
  }
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
