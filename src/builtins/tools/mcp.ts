/**
 * Built-in `mcp-server` Tools factory \u2014 spawns a stdio MCP server
 * and adapts its tools to Loom's `Tool` interface.
 *
 * Registered as a `ContributionRegistration<Tools>` in the built-in
 * Tools-factory registry (`src/builtins/index.ts`). The manifest
 * shape that produces an instance:
 *
 *     [providers]
 *     fs_mcp = { provider = "mcp-server", npm = "@mcp/server-filesystem" }
 *     linear = { provider = "mcp-server", command = "npx", args = ["@linear/mcp"] }
 *
 *     [tools.read_text_file]
 *     provider = "fs_mcp"
 *
 * Lifecycle:
 *
 *   1. **create()** \u2014 reads config (`command` + `args` or the `npm`
 *      shorthand), opens an MCP stdio transport, constructs the
 *      Client, and returns a `McpServerTools` instance.
 *   2. **init()** \u2014 connects the client (which performs MCP's
 *      `initialize` handshake automatically), then caches
 *      `tools/list` so resolveTool can dispatch without a round-trip
 *      per call.
 *   3. **resolveTool()** \u2014 in Chunk 2 always returns null. Chunk 3
 *      wires up the cache lookup + per-tool `Tool` construction.
 *   4. **close()** \u2014 closes the transport (which signals the child
 *      process to exit). We follow up with `SIGTERM` then `SIGKILL`
 *      after a short grace period so a hung server can't pin the
 *      Loom process indefinitely.
 *
 * Storage:
 *
 *   `FactoryContext.storage` is available; the v1 factory keeps
 *   everything in-memory (the in-memory `toolsCache` plus child
 *   process state via the SDK transport) and does not yet write
 *   to disk. Future enhancements like cached `tools/list` results
 *   for faster boots or PID files for graceful shutdown across
 *   crashes should land under `<ctx.storage>/mcp/<provider-handle>/`
 *   (convention; namespace by factory name + handle to avoid
 *   stomping sibling factories).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
import * as path from "node:path";

import { ManifestError, SecretError } from "../../errors.js";
import { applyArgGrant } from "../../manifest/capabilities.js";
import type { ContributionRegistration } from "../../providers/loader.js";
import type {
  Agent,
  FactoryContext,
  InitArgs,
  SecretNeeds,
  Tool,
  ToolConfig,
  ToolResult,
  Tools,
} from "../../types/interfaces.js";
import type { CapabilitySet } from "../../types/manifest.js";
import type { JSONSchema } from "../../types/schema.js";

/**
 * Config accepted by the `mcp-server` factory. One of `command` or
 * `npm` must be present. Per-handle `[providers]` config and per-tool
 * `[tools.X]` config are merged before reaching `create()` (tool
 * keys win on collision \u2014 see resolver).
 */
interface McpServerConfig {
  /** Direct command to run (e.g. `"node"`, `"npx"`). */
  command?: string;
  /** Arguments for `command`. */
  args?: string[];
  /** Working directory for the child. Defaults to `ctx.manifestDir`. */
  cwd?: string;
  /** Extra env vars merged into the child's environment. */
  env?: Record<string, string>;
  /**
   * Shorthand: launch `node <resolved-main-of-pkg>`. Resolved via
   * Node's `require.resolve` against `ctx.manifestDir` first, then
   * falls back to Loom's own `node_modules`.
   */
  npm?: string;
  /**
   * Mapping of secret-name \u2192 env-var name to inject. Used in Chunk 6;
   * accepted (and validated) here but ignored at the lifecycle layer.
   */
  secrets?: Record<string, string>;
}

/**
 * Server info returned by the MCP `initialize` request. Stored for
 * audit display.
 */
export interface McpServerInfo {
  name: string;
  version: string;
  /** Raw server capabilities map; only used for audit display today. */
  capabilities: Record<string, unknown>;
  /** MCP protocol version the server agreed to. */
  protocolVersion: string;
}

/**
 * The Tools instance returned by `create()`. Public for Chunk 7
 * audit attribution \u2014 audit reaches in for `serverInfo`.
 */
export class McpServerTools implements Tools {
  /** Server info captured during `init()`; undefined until then. */
  public serverInfo?: McpServerInfo;
  /** Tool list cached on `init()`; populated in Chunk 3. */
  public toolsCache: Map<string, McpTool> = new Map();

  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(
    public readonly client: Client,
    public readonly transport: StdioClientTransport,
    public readonly config: McpServerConfig,
  ) {}

  async init(_args: InitArgs): Promise<void> {
    void _args;
    if (this.closed) {
      throw new Error("McpServerTools.init() called after close()");
    }
    // `connect()` runs MCP's `initialize` handshake under the hood.
    // Errors here mean the child process didn't start, didn't speak
    // MCP, or didn't agree on a protocol version.
    await this.client.connect(this.transport);
    const info = this.client.getServerVersion();
    const caps = this.client.getServerCapabilities();
    this.serverInfo = {
      name: info?.name ?? "(unknown)",
      version: info?.version ?? "(unknown)",
      capabilities: (caps ?? {}) as Record<string, unknown>,
      // protocolVersion accessor isn't typed on the Client; the
      // value lives on the underlying transport's negotiated header.
      // We use a best-effort literal until a future SDK exposes it.
      protocolVersion: "2024-11-05",
    };

    // Cache the server's tool list so resolveTool can dispatch
    // without a round-trip per call. The list is captured ONCE here
    // — Loom's static-enumeration policy means we don't react to
    // `tools/list_changed` notifications at runtime. If a server
    // reshapes its tool surface, the user re-runs `loom audit`.
    const { tools } = await this.client.listTools();
    for (const t of tools) this.toolsCache.set(t.name, t);
  }

  resolveTool(
    name: string,
    config: ToolConfig,
    _agent: Agent,
    capabilities: CapabilitySet | undefined,
  ): Tool | null {
    void _agent;
    // Optional `mcp_tool` rename: when set, the manifest key
    // (`name`) is the model-facing name and `config.mcp_tool` names
    // the underlying MCP tool to dispatch to. When omitted, the
    // manifest key IS the MCP tool name. This is what lets the user
    // expose the same MCP tool under multiple model-facing names
    // (Chunk 5's partial-application story).
    const mcpName = readMcpToolName(config) ?? name;
    const mcp = this.toolsCache.get(mcpName);
    if (!mcp) return null;
    return buildLoomTool({
      modelFacingName: name,
      mcpName,
      mcpTool: mcp,
      client: this.client,
      capabilities,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      // `client.close()` ends the transport, which closes the child's
      // stdin and lets it shut down gracefully. The SDK's
      // StdioClientTransport.close() also SIGTERMs the child for us.
      try {
        await this.client.close();
      } catch {
        // Best effort: failures during close shouldn't mask the
        // original error that triggered shutdown.
      }
      // Belt-and-braces: if the transport's child somehow survived,
      // give it a short grace period then SIGKILL. We reach in via
      // the transport's internals because the SDK doesn't expose
      // the PID directly. (Safe: transports are public types whose
      // internals are stable across patch versions.)
      try {
        const proc = (
          this.transport as unknown as {
            _process?: {
              pid?: number;
              kill: (s?: NodeJS.Signals) => boolean;
              killed?: boolean;
            };
          }
        )._process;
        if (proc?.pid && proc.killed !== true) {
          await graceful(proc);
        }
      } catch {
        /* nothing to do */
      }
    })();
    return this.closing;
  }
}

/**
 * The factory entry. Registered in `src/builtins/index.ts`.
 */
export const mcpServerToolsFactory: ContributionRegistration<Tools> = {
  name: "mcp-server",

  // No static `secrets` field — every MCP server's needs are
  // user-declared per-instance via the `secrets` config on the
  // `[providers]` / `[tools.X]` entry. The runtime calls
  // `instanceSecretNeeds(config)` during Phase 1 to discover what
  // to load.
  instanceSecretNeeds(
    config: Record<string, unknown>,
  ): SecretNeeds | undefined {
    const map = (config as Record<string, unknown>)["secrets"];
    if (!map || typeof map !== "object" || Array.isArray(map)) return undefined;
    // The KEY of `secrets = { LOOM_NAME = "ENV_VAR" }` is the Loom
    // secret name to look up in the store. We treat all of them as
    // required — a server that needs an API key shouldn't boot
    // silently without it.
    const required = Object.keys(map as Record<string, unknown>);
    if (required.length === 0) return undefined;
    return { required };
  },

  create(
    rawConfig: Record<string, unknown>,
    ctx: FactoryContext,
    secrets: Record<string, string>,
    _parent: Agent | undefined,
  ): Tools {
    void _parent;
    const config = parseConfig(rawConfig);
    const [command, args] = resolveLaunchCommand(config, ctx);

    // Build env: start from the SDK's safe-by-default env (excludes
    // most user env), layer in the user's explicit `env` overrides,
    // and finally apply the secret → env-var mappings declared on
    // the instance. Secret values came from the Loom secret store via
    // `instanceSecretNeeds()` upstream.
    const env: Record<string, string> = { ...(config.env ?? {}) };
    if (config.secrets) {
      for (const [loomName, envVarName] of Object.entries(config.secrets)) {
        const value = secrets[loomName];
        if (value === undefined) {
          throw new SecretError(
            `mcp-server: secret '${loomName}' (mapped to env var '${envVarName}') ` +
              `wasn't found in the secret store. Add it via the keychain, ` +
              `~/.loom-secrets, or the manifest's .loom-secrets file.`,
          );
        }
        env[envVarName] = value;
      }
    }

    const transport = new StdioClientTransport({
      command,
      args,
      cwd: config.cwd ?? ctx.manifestDir,
      // Mix our env over the SDK default safe set.
      env: { ...defaultSdkEnv(), ...env },
      // Forward child stderr to ours so the user sees MCP server
      // logs alongside Loom's output. (StdioClientTransport defaults
      // to "inherit" too; spelled out for clarity.)
      stderr: "inherit",
    });

    const client = new Client(
      {
        name: `loom (${ctx.agentName})`,
        version: ctx.loomVersion,
      },
      {
        // No client-side capabilities are needed for tool calls.
        capabilities: {},
      },
    );

    return new McpServerTools(client, transport, config);
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function parseConfig(raw: Record<string, unknown>): McpServerConfig {
  const c: McpServerConfig = {};
  if (raw.command !== undefined) {
    if (typeof raw.command !== "string" || raw.command.length === 0) {
      throw new ManifestError(
        `mcp-server: 'command' must be a non-empty string`,
      );
    }
    c.command = raw.command;
  }
  if (raw.args !== undefined) {
    if (
      !Array.isArray(raw.args) ||
      raw.args.some((a) => typeof a !== "string")
    ) {
      throw new ManifestError(`mcp-server: 'args' must be an array of strings`);
    }
    c.args = raw.args as string[];
  }
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== "string" || raw.cwd.length === 0) {
      throw new ManifestError(`mcp-server: 'cwd' must be a non-empty string`);
    }
    c.cwd = raw.cwd;
  }
  if (raw.env !== undefined) {
    if (!isStringStringRecord(raw.env)) {
      throw new ManifestError(
        `mcp-server: 'env' must be a table of string->string`,
      );
    }
    c.env = raw.env;
  }
  if (raw.npm !== undefined) {
    if (typeof raw.npm !== "string" || raw.npm.length === 0) {
      throw new ManifestError(`mcp-server: 'npm' must be a non-empty string`);
    }
    c.npm = raw.npm;
  }
  if (raw.secrets !== undefined) {
    if (!isStringStringRecord(raw.secrets)) {
      throw new ManifestError(
        `mcp-server: 'secrets' must be a table of secret-name -> env-var-name`,
      );
    }
    c.secrets = raw.secrets;
  }
  if (!c.command && !c.npm) {
    throw new ManifestError(
      `mcp-server: one of 'command' or 'npm' must be set. ` +
        `Use 'npm = "@some/server"' for npm-distributed servers or ` +
        `'command = "..."' with optional 'args' for arbitrary binaries.`,
    );
  }
  if (c.command && c.npm) {
    throw new ManifestError(
      `mcp-server: 'command' and 'npm' are mutually exclusive`,
    );
  }
  return c;
}

function isStringStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== "string") return false;
  }
  return true;
}

/**
 * Resolve the (command, args) tuple to actually exec. The `npm`
 * shorthand resolves the package's main entry against the manifest
 * directory first (so manifest-local installs win), then falls back
 * to Loom's own `node_modules` (useful for `loom mcp inspect`-style
 * one-offs).
 */
function resolveLaunchCommand(
  c: McpServerConfig,
  ctx: FactoryContext,
): [string, string[]] {
  if (c.npm) {
    const resolved = resolveNpmEntry(c.npm, ctx.manifestDir);
    return ["node", [resolved, ...(c.args ?? [])]];
  }
  return [c.command as string, c.args ?? []];
}

function resolveNpmEntry(npmName: string, manifestDir: string): string {
  // First try resolution rooted at the manifest dir (mirrors how
  // Loom's provider loader walks `<manifestDir>/.loom/node_modules`
  // and ancestor `node_modules`). createRequire scoped to a path
  // inside manifestDir gets Node's full ancestor walk for free.
  const reqAtManifest = createRequire(
    path.join(manifestDir, "noop-for-require-anchor.js"),
  );
  try {
    return reqAtManifest.resolve(npmName);
  } catch {
    /* fall through */
  }
  // Fallback: resolve against this module's own location (Loom's
  // own node_modules). Lets a user run a bare `loom mcp inspect`
  // against a globally-known server without manifest-local install.
  const reqAtLoom = createRequire(import.meta.url);
  try {
    return reqAtLoom.resolve(npmName);
  } catch (e) {
    throw new ManifestError(
      `mcp-server: cannot resolve npm package '${npmName}'. ` +
        `Install it next to the manifest (\`npm install ${npmName}\`) ` +
        `or in Loom's own node_modules. Underlying error: ` +
        `${(e as Error).message}`,
    );
  }
}

/**
 * The SDK's `getDefaultEnvironment()` walks `process.env` and keeps
 * only a known-safe set (PATH, HOME, USER, etc.). Wrapping the call
 * here keeps the surface small and lets us swap policies later
 * without touching `create()`.
 */
function defaultSdkEnv(): Record<string, string> {
  return getDefaultEnvironment();
}

/**
 * Pull `mcp_tool` out of the per-tool config (set on `[tools.X]`).
 * Reserved keys on the config: `mcp_tool` (Chunk 3 rename) and
 * `secrets` (Chunk 6 per-instance secret map). The MCP factory is
 * the only consumer of these; the parser doesn't know about them.
 */
function readMcpToolName(config: ToolConfig): string | undefined {
  const v = (config as Record<string, unknown>)["mcp_tool"];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0) {
    throw new ManifestError(
      `mcp-server: 'mcp_tool' on a [tools.X] entry must be a non-empty string`,
    );
  }
  return v;
}

/**
 * Construct a Loom `Tool` from a discovered MCP tool.
 *
 * Three pieces fit together here:
 *
 *   1. **Capability-kind declaration.** Loom's existing
 *      `assertRequires` / `assertKnownKinds` machinery expects
 *      `Tool.requires` and `Tool.optional` to enumerate the kinds
 *      a grant may reference. For MCP-backed tools the "kinds" ARE
 *      the JSON-Schema property names — so we lift them out of
 *      `inputSchema` and declare them as requires/optional. That
 *      makes `[capabilities].X = { path = "..." }` a known-kind
 *      grant from the runtime's point of view.
 *
 *   2. **Schema narrowing.** `applyArgGrant` turns the per-arg
 *      grant into (narrowed inputSchema, bound merge values). The
 *      narrowed schema is what the model sees; bound values get
 *      merged in at execute() time and never reach the LLM.
 *
 *   3. **Override guard.** If the model tries to pass a value for a
 *      bound arg (e.g. by ignoring its now-removed schema property),
 *      execute() rejects with a clear error instead of silently
 *      letting the model overwrite a fixed binding.
 */
function buildLoomTool(args: {
  modelFacingName: string;
  mcpName: string;
  mcpTool: McpTool;
  client: Client;
  capabilities: CapabilitySet | undefined;
}): Tool {
  const { modelFacingName, mcpName, mcpTool, client, capabilities } = args;
  const rawSchema = (mcpTool.inputSchema as JSONSchema) ?? {
    type: "object",
    properties: {},
  };
  // Extract the property + required arrays from the MCP schema so we
  // can populate Tool.requires / Tool.optional. The runtime's boot
  // guards (`assertRequires`, `assertKnownKinds`) walk those.
  const schemaObj = (rawSchema ?? {}) as Record<string, unknown>;
  const allProps =
    schemaObj.properties && typeof schemaObj.properties === "object"
      ? Object.keys(schemaObj.properties as Record<string, unknown>)
      : [];
  const requiredArgs = Array.isArray(schemaObj.required)
    ? (schemaObj.required as unknown[]).filter(
        (x): x is string => typeof x === "string",
      )
    : [];
  const optionalArgs = allProps.filter((p) => !requiredArgs.includes(p));

  // Apply the capability grant: narrowed schema + bound merge map.
  const applied = applyArgGrant(rawSchema, capabilities);

  const baseDescription = mcpTool.description ?? `MCP tool: ${mcpName}`;
  const boundArgNames = Object.keys(applied.bound);

  const tool: Tool = {
    name: modelFacingName,
    description: annotateForBoundArgs(baseDescription, boundArgNames),
    inputSchema: applied.schema,
    // Required MCP args declared as `requires` so a manifest that
    // forgets to grant them fails boot via `assertRequires`. Optional
    // MCP args go to `optional` so `assertKnownKinds` doesn't flag
    // them as typos.
    requires: requiredArgs,
    optional: optionalArgs,
    ...(capabilities !== undefined ? { capabilities } : {}),
    async execute(input: unknown): Promise<ToolResult> {
      // The MCP spec lets `arguments` be omitted; we coerce
      // non-object inputs to `{}` so the spec is honored even when
      // Ajv hasn't seen the schema (e.g. unconstrained surface).
      const modelArgs =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      // Reject attempts to override a bound arg. With a narrowed
      // schema Ajv would already reject these as additionalProperties
      // when the server's schema is strict, but MCP servers vary;
      // explicit guard keeps the contract intact regardless.
      for (const k of Object.keys(modelArgs)) {
        if (Object.hasOwn(applied.bound, k)) {
          return {
            content:
              `MCP tool '${mcpName}': argument '${k}' is bound by ` +
              `[capabilities]; the model isn't allowed to override it.`,
            isError: true,
          };
        }
      }
      const argumentsObject = { ...applied.bound, ...modelArgs };
      let result: CallToolResult;
      try {
        result = (await client.callTool({
          name: mcpName,
          arguments: argumentsObject,
        })) as CallToolResult;
      } catch (e) {
        return {
          content: `MCP tool '${mcpName}' failed: ${(e as Error).message}`,
          isError: true,
        };
      }
      return mcpResultToLoom(result);
    },
  };
  return tool;
}

/**
 * Annotate a tool's MCP-provided description with a host-side note
 * when arguments have been pre-bound via `[capabilities]`.
 *
 * The MCP tool's original description was written assuming the
 * model would supply every argument. When Loom strips a pre-bound
 * argument from the model-visible schema, the description's
 * mentions of that argument become misleading: the model sees a
 * description saying "pass `doc_id`" alongside a schema that has
 * no `doc_id` field. Without a clarifying note, the model is
 * likely to invent the value or get stuck.
 *
 * The annotation is appended as an opaque host-authored block.
 * Argument NAMES are surfaced; bound VALUES are not (they may
 * contain secrets, internal paths, or other sensitive literals —
 * the model doesn't need them to function).
 */
function annotateForBoundArgs(
  baseDescription: string,
  boundArgs: string[],
): string {
  if (boundArgs.length === 0) return baseDescription;
  const list = boundArgs.map((a) => `\`${a}\``).join(", ");
  const plural = boundArgs.length === 1 ? "argument is" : "arguments are";
  return (
    `${baseDescription}\n\n` +
    `(Host note: the ${list} ${plural} pre-configured by the agent ` +
    `manifest and supplied automatically on every call. Do NOT include ` +
    `${boundArgs.length === 1 ? "it" : "them"} in your tool input — the ` +
    `tool's input schema reflects only the arguments you should pass.)`
  );
}

/**
 * Convert an MCP `CallToolResult` into a Loom `ToolResult`.
 *
 *   - Text content concatenates with newline separators.
 *   - Image / audio / resource / resource_link content fall back to
 *     a JSON dump (callers that care about binary data can revisit
 *     this later — the v1 contract is "model sees a string").
 *   - `isError: true` on the MCP side propagates to Loom.
 */
function mcpResultToLoom(result: CallToolResult): ToolResult {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text"
    ) {
      parts.push(String((item as { text?: unknown }).text ?? ""));
    } else {
      // Image, audio, resource, resource_link, future kinds. Surface
      // as a JSON blob so the model at least sees that something
      // came back. v1 contract; revisit when Loom learns multimodal.
      parts.push(JSON.stringify(item));
    }
  }
  const content = parts.length === 0 ? "" : parts.join("\n");
  return {
    content,
    ...(result.isError === true ? { isError: true } : {}),
  };
}

/**
 * Send SIGTERM then SIGKILL after a short grace period. Used as a
 * fallback if the transport's own close didn't reap the child.
 */
async function graceful(proc: {
  pid?: number;
  kill: (signal?: NodeJS.Signals) => boolean;
  killed?: boolean;
}): Promise<void> {
  if (!proc.pid || proc.killed) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    /* race; child gone already */
  }
  // Short grace period; MCP servers are usually well-behaved on
  // EOF + SIGTERM.
  await new Promise((r) => setTimeout(r, 250));
  if (proc.killed) return;
  try {
    proc.kill("SIGKILL");
  } catch {
    /* gone */
  }
}
