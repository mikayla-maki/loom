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
    /** Either a path (relative to manifest) or already-loaded inline content. */
    identity?: string;
    identityInline?: string;
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
}

export type SubagentReference =
  | { kind: "path"; path: string }
  | { kind: "registry"; name: string }
  | { kind: "inline"; manifest: AgentManifest }
  | { kind: "acp"; url: string };
