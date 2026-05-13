/**
 * `loom mcp inspect <provider-spec>` — dump the tools an MCP server
 * advertises as a TOML snippet ready to paste into a manifest.
 *
 * This is an **authoring aid**, not a runtime feature. Loom's
 * static-enumeration policy means every tool the model can call must
 * appear by name in `[tools]`. `inspect` exists so users don't have
 * to type 20 stub entries by hand for a 20-tool server: it spawns
 * the server, calls `tools/list`, kills the server, prints TOML the
 * user pastes and prunes.
 *
 * Usage:
 *
 *     loom mcp inspect <provider-spec> [--manifest <agent.toml>] [--json]
 *
 * Provider spec shapes:
 *
 *   - `@scope/pkg` — npm package shorthand (→ `{ npm = "..." }`)
 *   - `./path/to/server.js` — path shorthand (→ `command = "node"`,
 *                              `args = ["./path/to/server.js"]`)
 *   - `<handle>` — bare handle from `[providers]` in `--manifest`
 *
 * Output (default): a TOML snippet with one `[tools.X]` per
 * advertised tool plus a commented-out `[capabilities]` block
 * suggesting plausible pre-bindings. `--json` emits the raw
 * tools/list result for machine consumers.
 */

import * as path from "node:path";

import { LoomError } from "../errors.js";
import { DEFAULT_CLIENT_ACP_CAPABILITIES } from "../runtime/acp-capabilities.js";
import {
  McpServerTools,
  mcpServerToolsFactory,
} from "../builtins/tools/mcp.js";
import { parseAgentManifest } from "../manifest/parser.js";
import { transientStorage } from "../runtime/storage.js";
import type { FactoryContext, InitArgs } from "../types/interfaces.js";

export interface McpInspectOptions {
  /**
   * Path to a manifest, used to resolve bare-handle provider specs
   * against the manifest's `[providers]` table. Required when the
   * provider spec is a bare handle.
   */
  manifestPath?: string;
  /** Print JSON instead of TOML. */
  json?: boolean;
  /** Handle suggested in the TOML snippet's `[providers]` entry. */
  suggestedHandle?: string;
}

export interface McpInspectResult {
  /** Server's name from the `initialize` handshake. */
  serverName: string;
  /** Server version. */
  serverVersion: string;
  /** Discovered tools, in server-returned order. */
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
  }>;
  /** The TOML snippet (always produced; CLI may print this or JSON). */
  toml: string;
  /** Effective config used to launch the server. */
  launchConfig: Record<string, unknown>;
}

/**
 * Resolve a provider spec into the configured-factory `mcp-server`
 * config the factory's `create()` expects.
 */
export async function resolveProviderSpec(
  providerSpec: string,
  options: { manifestPath?: string } = {},
): Promise<{
  config: Record<string, unknown>;
  manifestDir: string;
  source: string;
}> {
  // Path-shaped: launch via node.
  if (
    providerSpec.startsWith("./") ||
    providerSpec.startsWith("../") ||
    providerSpec.startsWith("/") ||
    providerSpec.endsWith(".js") ||
    providerSpec.endsWith(".mjs")
  ) {
    return {
      config: { command: process.execPath, args: [providerSpec] },
      manifestDir: process.cwd(),
      source: `path:${providerSpec}`,
    };
  }
  // npm-shaped: contains a slash AND isn't a bare handle.
  if (providerSpec.includes("/") || providerSpec.startsWith("@")) {
    return {
      config: { npm: providerSpec },
      manifestDir: process.cwd(),
      source: `npm:${providerSpec}`,
    };
  }
  // Bare handle: requires --manifest to resolve.
  if (!options.manifestPath) {
    throw new LoomError(
      `loom mcp inspect: provider spec '${providerSpec}' looks like a [providers] ` +
        `handle; pass --manifest <agent.toml> so it can be resolved.`,
    );
  }
  const manifestAbs = path.resolve(options.manifestPath);
  const manifest = await parseAgentManifest(manifestAbs);
  const entry = manifest.providers?.[providerSpec];
  if (!entry) {
    throw new LoomError(
      `loom mcp inspect: no [providers].${providerSpec} entry in ${manifestAbs}. ` +
        `Declared: ${Object.keys(manifest.providers ?? {}).join(", ") || "(none)"}.`,
    );
  }
  if (!isConfiguredFactoryEntry(entry)) {
    throw new LoomError(
      `loom mcp inspect: [providers].${providerSpec} is a SourceSpec, not a ` +
        `configured-factory \`mcp-server\` entry. The inspect command only ` +
        `walks MCP servers.`,
    );
  }
  const { provider, ...config } = entry;
  if (provider !== "mcp-server") {
    throw new LoomError(
      `loom mcp inspect: [providers].${providerSpec} uses factory ` +
        `'${String(provider)}', not 'mcp-server'. The inspect command only ` +
        `walks MCP servers.`,
    );
  }
  return {
    config,
    manifestDir: path.dirname(manifestAbs),
    source: `manifest:${providerSpec}`,
  };
}

function isConfiguredFactoryEntry(
  entry: unknown,
): entry is { provider: string; [k: string]: unknown } {
  return (
    !!entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    "provider" in entry
  );
}

/**
 * Spawn the server, run `tools/list`, tear it down, and assemble
 * the result.
 */
export async function inspectMcpServer(
  providerSpec: string,
  options: McpInspectOptions = {},
): Promise<McpInspectResult> {
  const { config, manifestDir, source } = await resolveProviderSpec(
    providerSpec,
    { ...(options.manifestPath ? { manifestPath: options.manifestPath } : {}) },
  );
  const handle = options.suggestedHandle ?? suggestHandle(providerSpec);
  const ctx: FactoryContext = {
    manifestDir,
    agentName: "loom-mcp-inspect",
    loomVersion: "0.0.0",
    clientCapabilities: DEFAULT_CLIENT_ACP_CAPABILITIES,
    // Inspect is transient — spawn / list / kill. Real per-agent
    // storage would create a `loom-mcp-inspect/` dir per invocation;
    // tmpdir is the right scope for a throwaway probe.
    storage: transientStorage("loom-mcp-inspect"),
    metadata: {},
  };
  const tools = mcpServerToolsFactory.create(
    config,
    ctx,
    {},
    undefined,
  ) as McpServerTools;
  let serverName = "(unknown)";
  let serverVersion = "(unknown)";
  const toolList: McpInspectResult["tools"] = [];
  try {
    await tools.init!(initArgsFor(ctx, config));
    serverName = tools.serverInfo?.name ?? serverName;
    serverVersion = tools.serverInfo?.version ?? serverVersion;
    for (const [, t] of tools.toolsCache) {
      const tool: McpInspectResult["tools"][number] = { name: t.name };
      if (t.description !== undefined) tool.description = t.description;
      if (t.inputSchema !== undefined) tool.inputSchema = t.inputSchema;
      toolList.push(tool);
    }
  } finally {
    await tools.close();
  }
  return {
    serverName,
    serverVersion,
    tools: toolList,
    toml: renderTomlSnippet({
      handle,
      providerEntry: config,
      providerSpec,
      serverName,
      serverVersion,
      tools: toolList,
      source,
    }),
    launchConfig: config,
  };
}

function initArgsFor(
  ctx: FactoryContext,
  config: Record<string, unknown>,
): InitArgs {
  return {
    manifest: {
      name: ctx.agentName,
      harness: { provider: "test" },
    },
    config,
    secrets: {},
    factoryContext: ctx,
    runtime: {
      async requestPermission() {
        throw new Error("requestPermission not used by mcp inspect");
      },
    },
  };
}

/**
 * Heuristic for the suggested `[providers].handle` name. Strips
 * the npm scope and any `mcp-server-` / `server-` prefix so common
 * MCP packages get short, readable handles.
 */
export function suggestHandle(providerSpec: string): string {
  let s = providerSpec;
  // Drop scope (e.g. @modelcontextprotocol/server-filesystem → server-filesystem)
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  // Drop common prefixes.
  s = s.replace(/^server-/, "");
  s = s.replace(/^mcp-server-/, "");
  s = s.replace(/^mcp-/, "");
  // Drop file extension when the spec was a path.
  s = s.replace(/\.[mc]?js$/, "");
  // Toml-safe identifier.
  s = s.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!s) s = "mcp_server";
  if (!/^[a-zA-Z_]/.test(s)) s = `mcp_${s}`;
  return s;
}

/**
 * Render a paste-and-prune TOML snippet describing the server's
 * tools. The output is opinionated:
 *
 *   - A `[providers].<handle>` entry that mirrors the launch config.
 *   - One `[tools.<name>] provider = "<handle>"` block per tool,
 *     with the MCP-side schema dumped as a comment so reviewers see
 *     what they're enabling.
 *   - A `[capabilities]` block listing every tool with a commented-
 *     out hint (each arg defaults to `"*"` — unrestricted — since
 *     unrestricted is the safest default to make EXPLICIT rather
 *     than the silent inference).
 */
function renderTomlSnippet(args: {
  handle: string;
  providerEntry: Record<string, unknown>;
  providerSpec: string;
  serverName: string;
  serverVersion: string;
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  source: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Tools advertised by ${args.providerSpec}`);
  lines.push(`# (${args.serverName} ${args.serverVersion}).`);
  lines.push(
    `# Source: ${args.source}. Review each entry, prune what you don't want,`,
  );
  lines.push(`# and configure [capabilities] for what you keep.`);
  lines.push("");
  lines.push(`[providers]`);
  lines.push(
    `${args.handle} = ${renderInlineTable({
      provider: "mcp-server",
      ...args.providerEntry,
    })}`,
  );
  lines.push("");

  if (args.tools.length === 0) {
    lines.push(`# No tools advertised by ${args.providerSpec}.`);
    return lines.join("\n") + "\n";
  }

  for (const t of args.tools) {
    if (t.description) {
      for (const ln of t.description.split("\n")) {
        lines.push(`# ${ln}`);
      }
    }
    if (t.inputSchema) {
      lines.push(`# MCP schema: ${summariseSchema(t.inputSchema)}`);
    }
    lines.push(`[tools.${t.name}]`);
    lines.push(`provider = "${args.handle}"`);
    lines.push("");
  }

  lines.push(`[capabilities]`);
  lines.push(
    `# Uncomment the entries you keep. Each tool needs a grant before`,
  );
  lines.push(
    `# the runtime will let the model call it. Use "*" for whole-tool`,
  );
  lines.push(
    `# unrestricted access, or a per-arg map to pre-bind / narrow args.`,
  );
  for (const t of args.tools) {
    const hint = capabilityHintFor(t.inputSchema);
    lines.push(`# ${t.name} = ${hint}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Tiny inline-TOML emitter for objects whose values are strings,
 * numbers, booleans, or arrays of strings. The CLI's outputs are
 * always this shape; we deliberately avoid pulling in a full TOML
 * serializer to keep the dependency footprint minimal.
 */
function renderInlineTable(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    parts.push(`${k} = ${renderTomlValue(v)}`);
  }
  return `{ ${parts.join(", ")} }`;
}

function renderTomlValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    return `[${v.map(renderTomlValue).join(", ")}]`;
  }
  if (v && typeof v === "object") {
    return renderInlineTable(v as Record<string, unknown>);
  }
  return JSON.stringify(v);
}

/** One-line schema summary for review comments. */
function summariseSchema(schema: unknown): string {
  if (!schema || typeof schema !== "object") return JSON.stringify(schema);
  const s = schema as Record<string, unknown>;
  if (s.type === "object" && s.properties) {
    const props = s.properties as Record<string, { type?: string }>;
    const required = new Set((s.required as string[]) ?? []);
    const entries = Object.entries(props).map(([k, v]) => {
      const t = typeof v.type === "string" ? v.type : "?";
      const optional = required.has(k) ? "" : "?";
      return `${k}${optional}: ${t}`;
    });
    return `{ ${entries.join(", ")} }`;
  }
  return JSON.stringify(schema);
}

/**
 * Suggest a starting `[capabilities].X` grant for a tool. Defaults
 * every property to `"*"` (unrestricted) so the model can use the
 * tool right away; users tighten as needed. Tools with no
 * properties get the whole-tool `"*"`.
 */
function capabilityHintFor(schema: unknown): string {
  if (!schema || typeof schema !== "object") return `"*"`;
  const s = schema as { type?: unknown; properties?: Record<string, unknown> };
  if (s.type !== "object" || !s.properties) return `"*"`;
  const props = Object.keys(s.properties);
  if (props.length === 0) return `"*"`;
  const inner = props.map((p) => `${p} = "*"`).join(", ");
  return `{ ${inner} }`;
}
