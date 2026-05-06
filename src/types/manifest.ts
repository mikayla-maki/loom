/**
 * Manifest types — the shape of an agent definition, whether parsed from
 * disk (agent.toml + SKILL.md + tool.toml) or constructed in memory by an
 * SDK consumer.
 *
 * The manifest carries *unresolved* references (skill names, tool paths,
 * etc.). The resolver walks them and produces a `ResolvedAgentManifest`
 * with everything bound to concrete data.
 */

// ─── Capabilities ────────────────────────────────────────────────────────────

/**
 * Sandbox ceiling axes — the surface the agent's `[sandbox]` declaration
 * constrains. Absent axis = unconstrained on that axis (`*`). Empty array
 * = explicitly nothing.
 */
export interface SandboxCeiling {
  filesystem?: string[];
  network?: string[];
  secrets?: string[];
}

/**
 * Capabilities a tool declares about itself. Inherits the three sandbox
 * axes (used to validate that the union of tool needs ⊆ agent ceiling),
 * plus a `subagent` axis that's broker opt-in: a non-empty value tells the
 * runtime to wire this tool's spawn with `LOOM_INVOKE_*` env vars so it
 * can call subagents through `loom-invoke`.
 */
export interface ToolCapabilities extends SandboxCeiling {
  subagent?: string[] | "*";
}

// ─── System prompt ───────────────────────────────────────────────────────────

/**
 * `[agent].system_prompt` — either an inline literal, or a path to read
 * from disk. The string form is disambiguated by prefix (`./`, `../`,
 * `/`, `~/` → path; otherwise literal); the structured form is
 * unambiguous and allowed even when the literal would be path-shaped.
 */
export type SystemPromptSpec = string | { path: string };

// ─── Subagent reference ──────────────────────────────────────────────────────

export type SubagentReference =
  | { kind: "path"; path: string }
  | { kind: "registry"; name: string }
  | { kind: "acp"; url: string };

// ─── Agent manifest (input shape) ──────────────────────────────────
//
// The manifest is what the user provides — directly via `runAgent(spec)`
// or indirectly via `parseAgentManifest("./agent.toml")`. Agent identity
// fields (name / description / systemPrompt / removeBuiltinTools) live at
// the top level; the parser flattens TOML's `[agent]` table onto the same
// shape so file-based and inline forms produce identical objects.
//
// Skills, tools, and subagents may be expressed inline as nested objects
// OR as string refs (paths / registry names / "builtin"). The resolver
// dispatches on each.

/**
 * Configuration form: `{ provider: "name", ...config }`. The runtime
 * looks the factory up in the in-process registry by `provider` name,
 * passes the rest as config.
 */
export interface ProviderRefConfig {
  provider: string;
  [k: string]: unknown;
}

/**
 * Harness slot: either a config record (looked up by `provider` name) or
 * a pre-built `Harness` instance the runtime uses as-is. Detection is by
 * presence of a `provider: string` field — instances do not carry that.
 */
export type HarnessSpec = ProviderRefConfig | import("./interfaces.js").Harness;

/** Session slot — same shape rules as Harness. */
export type SessionSpec = ProviderRefConfig | import("./interfaces.js").Session;

export interface AgentManifest {
  /** Absolute path to the source file, if loaded from disk. */
  manifestPath?: string;
  /** Agent display name. Required. */
  name: string;
  description?: string;
  systemPrompt?: SystemPromptSpec;
  /** When true, suppress the auto-loaded `core` builtin skill. */
  removeBuiltinTools?: boolean;
  harness: HarnessSpec;
  /** Optional. Defaults to `{ provider: "memory" }` if absent. */
  session?: SessionSpec;
  /**
   * Per-axis sandbox ceiling. Whole table absent OR axis absent =
   * unconstrained (`*`). Empty array on an axis = explicitly nothing.
   */
  sandbox?: SandboxCeiling;
  /** Skill name → path / registry name / inline skill manifest. */
  skills?: Record<string, string | SkillManifest>;
  /**
   * Extensions: npm packages with a `loom.extension` field, loaded at boot.
   * Each entry's name is the package name; the value is the config object
   * passed to the package's `register()` function.
   *
   * For programmatic `Provider` instances, use `RunAgentOptions.providers`
   * instead. Extensions are a plugin-loading mechanism, not a place to
   * embed live runtime objects.
   */
  extensions?: Record<string, Record<string, unknown>>;
}

export interface SkillManifest {
  /** If present, must equal the parent map key. */
  name?: string;
  description: string;
  /** Markdown body. Defaults to empty string. */
  body?: string;
  /** Tool name → path / "builtin" / "builtin:<name>" / inline tool manifest. */
  requires?: Record<string, string | ToolManifest>;
  /** Subagent name → path / registry name / acp:// URL / structured reference. */
  subagents?: Record<string, string | SubagentReference>;
  /**
   * If true, the runtime renders this skill's body as part of the manifest's
   * core system prompt (rather than under `# Available Skills`), so the
   * model treats its tools as always-on. The auto-loaded `core` builtin
   * uses this to behave like ambient guidance, not an opt-in capability.
   */
  inlineInSystemPrompt?: boolean;

  // ── Disk-derived (parser-only fields) ──
  /** Absolute path to SKILL.md, when loaded from disk. */
  manifestPath?: string;
  /** Skill directory, when loaded from disk. Used as the base for relative tool paths. */
  skillDir?: string;
}

export interface ToolManifest {
  /** If present, must equal the parent map key. */
  name?: string;
  description: string;
  schema: import("./schema.js").JSONSchema;
  invocation: { command: string; args?: string[] };
  secrets?: { required?: string[]; optional?: string[] };
  capabilities?: ToolCapabilities;
  /**
   * Working directory for the spawned tool process. Defaults to the
   * tool's `toolDir` (when loaded from disk) or `process.cwd()` (when
   * declared inline).
   */
  cwd?: string;

  // ── Disk-derived (parser-only fields) ──
  /** Absolute path to tool.toml, when loaded from disk. */
  manifestPath?: string;
  /** Tool directory, when loaded from disk. */
  toolDir?: string;
  /** True iff the tool ships a `bin/` directory (auto-PATH'd). */
  shipsBinary?: boolean;
  binDir?: string;
}
