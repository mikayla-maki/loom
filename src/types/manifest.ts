/**
 * Manifest types — the shape of an agent definition, whether parsed from
 * disk (agent.toml + SKILL.md) or constructed in memory by an SDK consumer.
 *
 * The manifest carries unresolved references: tool entries are
 * `(name, config)` pairs that loom routes through the provider chain
 * to produce `Tool` objects. There's no on-disk tool format — tools
 * are JS code that an extension (or loom's native provider) registers.
 */

import type { ToolConfig } from "./interfaces.js";

// ─── System prompt ──────────────────────────────────────────────────────────

/**
 * `[agent].system_prompt` — either an inline literal, or a path to read
 * from disk. The string form is disambiguated by prefix (`./`, `../`,
 * `/`, `~/` → path; otherwise literal); the structured form is
 * unambiguous and allowed even when the literal would be path-shaped.
 */
export type SystemPromptSpec = string | { path: string };

// ─── Capabilities ───────────────────────────────────────────────

/**
 * Per-tool capability ceiling. Keyed by tool name; the value is whatever
 * shape that tool's `capabilities` uses. Loom uses each tool's
 * `capabilitiesContain` (or a structural default) to verify the tool's
 * declared caps fit inside the matching ceiling entry. Tools with no
 * matching entry have no extra ceiling check.
 */
export type Capabilities = Record<string, unknown>;

// ─── Agent manifest (input shape) ───────────────────────────────────────

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
  harness: HarnessSpec;
  /** Optional. Defaults to `{ provider: "memory" }` if absent. */
  session?: SessionSpec;
  /**
   * Per-tool capability ceiling, keyed by tool name. Optional. When
   * present, the tool's declared caps must fit inside the matching
   * ceiling entry (using the tool's `capabilitiesContain` or the
   * structural default).
   */
  capabilities?: Capabilities;
  /**
   * Top-level tools — model-facing name → tool config. Loom routes each
   * `(name, config)` pair through the provider chain. The native
   * provider claims known builtin names; extension providers claim
   * names they register.
   *
   * Semantics:
   *   - field absent       → loom auto-loads the default builtin set
   *                          (`bash`, `read_file`, `write_file`, `find`).
   *   - field present (any) → exactly what's listed; no defaults.
   *   - empty table        → no top-level tools at all.
   *
   * Skills' `requires:` are *additive*: a skill that brings `bash`
   * into scope is fine even if `bash` isn't listed here. A name
   * appearing in BOTH top-level `tools` AND a skill's `requires` is a
   * hard error — silent overrides are footguns.
   */
  tools?: Record<string, ToolConfig>;
  /** Skill name → path / registry name / inline skill manifest. */
  skills?: Record<string, string | SkillManifest>;
  /**
   * Extensions: npm packages with a `loom.extension` field, loaded at boot.
   * Each entry's name is the package name; the value is the config object
   * passed to the package's `register()` function.
   */
  extensions?: Record<string, Record<string, unknown>>;
}

export interface SkillManifest {
  /** If present, must equal the parent map key. */
  name?: string;
  description: string;
  /** Markdown body. Defaults to empty string. */
  body?: string;
  /** Tool name → config. Same shape and routing as top-level `[tools]`. */
  requires?: Record<string, ToolConfig>;

  // ── Disk-derived (parser-only fields) ──
  /** Absolute path to SKILL.md, when loaded from disk. */
  manifestPath?: string;
  /** Skill directory, when loaded from disk. */
  skillDir?: string;
}
