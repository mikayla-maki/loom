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
import { expandHome } from "../../internal/util.js";
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

interface McpServerConfig {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  npm?: string;
  secrets?: Record<string, string>;
}

export interface McpServerInfo {
  name: string;
  version: string;
  capabilities: Record<string, unknown>;
  protocolVersion: string;
}

export class McpServerTools implements Tools {
  public serverInfo?: McpServerInfo;
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
    await this.client.connect(this.transport);
    const info = this.client.getServerVersion();
    const caps = this.client.getServerCapabilities();
    this.serverInfo = {
      name: info?.name ?? "(unknown)",
      version: info?.version ?? "(unknown)",
      capabilities: (caps ?? {}) as Record<string, unknown>,
      // Client doesn't expose the negotiated protocol version; best-effort literal until a future SDK does.
      protocolVersion: "2024-11-05",
    };

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
    const mcpName = readBoundToolName(config) ?? name;
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
      try {
        await this.client.close();
      } catch {
        // Best effort: a close failure shouldn't mask the original shutdown error.
      }
      // If the child somehow survived transport close, SIGTERM/SIGKILL it. The SDK doesn't expose the PID, so reach into the transport's internals.
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

export const mcpServerToolsFactory: ContributionRegistration<Tools> = {
  name: "mcp-server",

  instanceSecretNeeds(
    config: Record<string, unknown>,
  ): SecretNeeds | undefined {
    const map = (config as Record<string, unknown>)["secrets"];
    if (!map || typeof map !== "object" || Array.isArray(map)) return undefined;
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
      cwd: config.cwd ? expandHome(config.cwd) : ctx.manifestDir,
      env: { ...defaultSdkEnv(), ...env },
      stderr: "inherit",
    });

    const client = new Client(
      {
        name: `loom (${ctx.agentName})`,
        version: ctx.loomVersion,
      },
      {
        capabilities: {},
      },
    );

    return new McpServerTools(client, transport, config);
  },
};

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

function resolveLaunchCommand(
  c: McpServerConfig,
  ctx: FactoryContext,
): [string, string[]] {
  const expandArgs = (args: string[]): string[] => args.map(expandHome);
  if (c.npm) {
    const resolved = resolveNpmEntry(c.npm, ctx.manifestDir);
    return ["node", [resolved, ...expandArgs(c.args ?? [])]];
  }
  return [expandHome(c.command as string), expandArgs(c.args ?? [])];
}

function resolveNpmEntry(npmName: string, manifestDir: string): string {
  // Resolve rooted at the manifest dir first so manifest-local installs win.
  const reqAtManifest = createRequire(
    path.join(manifestDir, "noop-for-require-anchor.js"),
  );
  try {
    return reqAtManifest.resolve(npmName);
  } catch {
    /* fall through */
  }
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

function defaultSdkEnv(): Record<string, string> {
  return getDefaultEnvironment();
}

function readBoundToolName(config: ToolConfig): string | undefined {
  const v = (config as Record<string, unknown>)["tool"];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0) {
    throw new ManifestError(
      `mcp-server: 'tool' on a [tools.X] entry must be a non-empty string`,
    );
  }
  return v;
}

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

  const applied = applyArgGrant(rawSchema, capabilities);

  const baseDescription = mcpTool.description ?? `MCP tool: ${mcpName}`;
  const boundArgNames = Object.keys(applied.bound);

  const tool: Tool = {
    name: modelFacingName,
    description: annotateForBoundArgs(baseDescription, boundArgNames),
    inputSchema: applied.schema,
    requires: requiredArgs,
    optional: optionalArgs,
    ...(capabilities !== undefined ? { capabilities } : {}),
    async execute(input: unknown): Promise<ToolResult> {
      const modelArgs =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      for (const k of Object.keys(modelArgs)) {
        if (Object.hasOwn(applied.bound, k)) {
          return {
            content:
              `MCP tool '${mcpName}': argument '${k}' is bound by ` +
              `[capabilities]; the model isn't allowed to override it.`,
            isError: true,
          };
        }
        // When a per-arg map grant narrowed the schema, the granted args form a
        // closed whitelist. Enforce it here rather than relying on the schema's
        // `additionalProperties`: many MCP servers omit it, and Ajv runs with
        // `strict:false`, so a dropped arg the manifest deliberately withheld
        // would otherwise pass validation and reach the server verbatim.
        if (applied.narrowed && !applied.modelArgs.has(k)) {
          return {
            content:
              `MCP tool '${mcpName}': argument '${k}' is not permitted by the ` +
              `[capabilities] grant for this tool.`,
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
      parts.push(JSON.stringify(item));
    }
  }
  const content = parts.length === 0 ? "" : parts.join("\n");
  return {
    content,
    ...(result.isError === true ? { isError: true } : {}),
  };
}

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
  await new Promise((r) => setTimeout(r, 250));
  if (proc.killed) return;
  try {
    proc.kill("SIGKILL");
  } catch {
    /* gone */
  }
}
