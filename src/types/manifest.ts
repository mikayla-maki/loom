/**
 * Manifest types — the parsed shape of agent.toml, tool.toml, and SKILL.md.
 *
 * These are the result of parsing + minimal normalization. Resolution
 * (walking skill→tool deps, fetching secrets, validating capabilities)
 * happens in src/manifest/resolver.ts.
 */

/** Capability ceiling on an agent / actually-required surface of a tool. */
export interface Capabilities {
  filesystem?: string[];
  network?: string[];
  secrets?: string[];
  /** Names of subagents this scope is allowed to invoke (v1). */
  subagent?: string[] | "*";
}

/** Parsed `agent.toml` (after path resolution but before dependency walk). */
export interface AgentManifest {
  /** Absolute path to the manifest file. Used as the base for relative paths. */
  manifestPath: string;
  agent: {
    name: string;
    description?: string;
    /**
     * `[agent].system_prompt` — the static, manifest-owned portion of the
     * system prompt the runtime assembles each turn.
     *
     * Stored verbatim. The resolver decides whether it's a path or inline:
     *   - path-like (`./`, `../`, `/`, `~/` prefix) → read from disk
     *   - anything else → used as the literal text
     */
    systemPrompt?: string;
    /**
     * `[agent].remove_builtin_tools` — when true, suppress the auto-loaded
     * `core` builtin skill (bash / read_file / write_file / find). The
     * agent only sees the tools its manifest brings in via `[skills]`.
     * Default: false.
     */
    removeBuiltinTools?: boolean;
  };
  harness: {
    provider: string;
    [key: string]: unknown;
  };
  session: {
    provider: string;
    [key: string]: unknown;
  };
  sandbox: Capabilities;
  /** Map of skill name → path (relative or registry name). */
  skills: Record<string, string>;
  /**
   * Map of extension-name → config for *Provider* extensions. Providers
   * dynamically contribute tools/skills at boot — for example, an MCP
   * extension that exposes MCP-server tools as Glass tools.
   */
  providers: Record<string, Record<string, unknown>>;
  /**
   * Map of npm-package-name → config for Glass *extension packages*. At
   * boot, each listed package is dynamic-imported and its register()
   * function is called; the package decides what to install (harnesses,
   * sessions, providers).
   *
   *   [extensions]
   *   "mcp-glass-extension" = { servers = ["filesystem"] }
   *   "@example/glass-foo" = {}
   *
   * Discovery scopes <manifestDir>/node_modules → npm global root →
   * ~/.glass/extensions.
   */
  extensions: Record<string, Record<string, unknown>>;
}

/** Parsed `tool.toml` declaration. */
export interface ToolManifest {
  manifestPath: string;
  toolDir: string;
  tool: {
    name: string;
    description: string;
    schema: import("./schema.js").JSONSchema;
    invocation: {
      command: string;
      /** Optional explicit args before the JSON-on-stdin payload. */
      args?: string[];
    };
    secrets: { required: string[]; optional?: string[] };
    capabilities: Capabilities;
  };
  /** Whether the tool ships its own bin/ directory (auto-PATH'd). */
  shipsBinary: boolean;
  binDir?: string;
}

/** Parsed `SKILL.md` — frontmatter + body. */
export interface SkillManifest {
  manifestPath: string;
  skillDir: string;
  name: string;
  description: string;
  /** model-facing knowledge content (markdown body). */
  body: string;
  /** Map of tool name (model-facing) → path or "builtin". */
  requires: Record<string, string>;
  /** v1: subagents this skill may invoke (path / inline / acp:// / registry). */
  subagents?: Record<string, SubagentReference>;
  /**
   * If true, the runtime renders this skill's body as part of the manifest's
   * core system prompt (rather than under `# Available Skills`), so the
   * model treats its tools as always-on. The auto-loaded `core` builtin
   * uses this to behave like ambient guidance, not an opt-in capability.
   */
  inlineInSystemPrompt?: boolean;
}

export type SubagentReference =
  | { kind: "path"; path: string }
  | { kind: "registry"; name: string }
  | { kind: "inline"; manifest: AgentManifest }
  | { kind: "acp"; url: string };
