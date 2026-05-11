/**
 * ToolTable — name → Tool registry the runtime executes against.
 *
 * Built once after every provider has resolved their tools. Validates
 * input against each tool's `inputSchema` before dispatch, builds a
 * fresh `ToolContext` per call (with the secret slice filtered to the
 * tool's allowlist), and surfaces tool errors as `isError` results
 * rather than throwing into the harness.
 */

import Ajv, { type ValidateFunction } from "ajv";

import { ToolExecutionError, ToolInputError } from "../errors.js";
import type {
  Tool,
  ToolCall,
  ToolContext,
  ToolDescriptor,
  ToolResult,
} from "../types/interfaces.js";

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });

/**
 * Tool registration entry — Tool plus the secret allowlist filtered
 * into its per-call `ctx.secrets`.
 */
export interface ToolEntry {
  tool: Tool;
  allowedSecrets: Set<string>;
}

/**
 * Builds a fresh `ToolContext` per `execute()` call. The runtime
 * supplies this; it captures the runtime primitives the tool's context
 * methods route to. The `tool` is the entry being dispatched —
 * lookups like `ctx.spawnSubagent(name)` read off
 * `tool.dependencies.subagents`.
 */
export interface ToolContextFactory {
  build(args: { allowedSecrets: Set<string>; tool: Tool }): ToolContext;
}

export class ToolTable {
  private readonly byName = new Map<string, ToolEntry>();
  private readonly secrets: Record<string, string>;
  private readonly contextFactory: ToolContextFactory;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(opts: {
    tools: Array<Tool | ToolEntry>;
    secrets: Record<string, string>;
    contextFactory: ToolContextFactory;
  }) {
    this.secrets = opts.secrets;
    this.contextFactory = opts.contextFactory;
    for (const t of opts.tools) {
      const entry = isToolEntry(t)
        ? t
        : { tool: t, allowedSecrets: new Set<string>() };
      this.byName.set(entry.tool.name, entry);
      try {
        this.validators.set(
          entry.tool.name,
          ajv.compile(entry.tool.inputSchema as object),
        );
      } catch (e) {
        throw new ToolInputError(
          `Invalid JSON schema for tool '${entry.tool.name}': ${(e as Error).message}`,
          { cause: e },
        );
      }
    }
  }

  list(): ToolDescriptor[] {
    return [...this.byName.values()].map((e) => ({
      name: e.tool.name,
      description: e.tool.description,
      inputSchema: e.tool.inputSchema,
    }));
  }

  /**
   * The full `Tool` instances backing the table, in insertion order.
   * Used by aggregation paths (e.g. ACP capability negotiation) that
   * need to call optional methods like `Tool.acpCapabilities()`.
   */
  tools(): Tool[] {
    return [...this.byName.values()].map((e) => e.tool);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const entry = this.byName.get(call.name);
    if (!entry) {
      return {
        content: `Unknown tool: ${call.name}. Available: ${[...this.byName.keys()].join(", ")}`,
        isError: true,
      };
    }
    const validate = this.validators.get(call.name);
    if (validate && !validate(call.input)) {
      const errors = (validate.errors ?? [])
        .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`)
        .join("; ");
      return {
        content: `Tool '${call.name}' input failed validation: ${errors}`,
        isError: true,
      };
    }
    const filteredSecrets = filterSecrets(this.secrets, entry.allowedSecrets);
    const ctx = this.contextFactory.build({
      allowedSecrets: entry.allowedSecrets,
      tool: entry.tool,
    });
    ctx.secrets = filteredSecrets;
    try {
      return await entry.tool.execute(call.input, ctx);
    } catch (e) {
      if (e instanceof ToolInputError || e instanceof ToolExecutionError) {
        return { content: (e as Error).message, isError: true };
      }
      throw e;
    }
  }
}

function isToolEntry(v: Tool | ToolEntry): v is ToolEntry {
  return (
    typeof v === "object" && v !== null && "tool" in v && "allowedSecrets" in v
  );
}

function filterSecrets(
  bag: Record<string, string>,
  allow: Set<string>,
): Record<string, string> {
  if (allow.size === 0) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(bag)) {
    if (allow.has(k)) out[k] = v;
  }
  return out;
}
