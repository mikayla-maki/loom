/**
 * Manifest types — the shape of an agent definition, parsed from
 * agent.toml or constructed in memory by an SDK consumer.
 *
 * Manifest v5 has one reference word (`provider`), one declaration
 * table (`[providers]`), and one resolution rule:
 *
 *   [providers]  — local handles for *code sources* (npm/path/git)
 *   [tools]      — model-facing verbs, each optionally wired via
 *                  the same `provider` field
 *
 * Every reference to code-on-disk is shape-first: a `Reference` is
 * either a bare local handle (string with no `/`, `@`, or `./`) or an
 * inline `SourceSpec` (string fast-path or table). The resolver
 * decides whether the bare handle resolves to a `[providers]` entry
 * or to a built-in registry name, parameterised by slot.
 *
 * See `internal-docs/manifest-v5.md` for the canonical design.
 */

// `import type` is erased at compile time, so the manifest ↔ interfaces
// type-only cycle is safe.
import type { Harness, Session } from "./interfaces.js";

// ─── System prompt ──────────────────────────────────────────────────────────

/**
 * `[agent].system_prompt` — inline literal or `{ path }`. As a string,
 * a `./`, `../`, `/`, or `~/` prefix means path; otherwise literal.
 * The table form is unambiguous and accepted even for path-shaped text.
 */
export type SystemPromptSpec = string | { path: string };

// ─── Capabilities ──────────────────────────────────────────────────────────

/**
 * Grant for one capability KIND. `"*"` = unrestricted; an array is a
 * kind-defined allowlist (usually string[]); a record is reserved for
 * richer per-kind structures. Absence from a `CapabilitySet` = denied.
 */
export type CapabilityValue = "*" | unknown[] | Record<string, unknown>;

/**
 * Full grant for one tool. `"*"` = whole tool unrestricted; otherwise
 * per-kind map. `{}` grants nothing — tools with non-empty `requires`
 * will fail boot.
 */
export type CapabilitySet = "*" | Record<string, CapabilityValue>;

/**
 * Per-tool grant table. Keyed by the same names used in `[tools]`.
 *
 * `[capabilities]` is a **downward-propagating ceiling** across the
 * subagent tree: a manifest's grants must contain (be a superset of)
 * every descendant subagent's grants. Crucially, `[capabilities]`
 * entries do NOT have to match local `[tools]` — a parent that will
 * spawn a subagent using `read_database` declares the ceiling for
 * `read_database` even when it has no `read_database` tool of its own.
 * See §1.6 of manifest-v5.md.
 */
export type Capabilities = Record<string, CapabilitySet>;

/**
 * Secret allowlist on `[agent].secrets`. Absent or `"*"` → no ceiling;
 * `[]` → no secrets; otherwise the listed names. Every tool's
 * `Tool.secrets.required ∪ optional` must be a subset when the array
 * form is set.
 */
export type SecretAllowlist = "*" | string[];

// ─── Source specs ──────────────────────────────────────────────────────────

/**
 * Where code lives on disk. Discriminated by which key is present.
 *
 * `"builtin"` is *not* a SourceSpec — built-in factories are looked up
 * by name in registries, not loaded from disk. Use a bare `Reference`
 * string for those.
 */
export type SourceSpec =
  | { npm: string; version?: string }
  | { path: string; subpath?: string };
// future: | { git: string; rev?: string; subpath?: string };

/**
 * A reference to code-on-disk OR to a named factory in a built-in
 * registry. Three on-disk shapes:
 *
 *   - **Bare-handle string** — no `/`, `@`, or `./` prefix. Looked up
 *     in `[providers]` first, then the slot's built-in registry
 *     (§1.2 of manifest-v5.md).
 *   - **SourceSpec string fast-path** — `"@org/pkg"` (npm),
 *     `"@org/pkg@^1.0"` (npm + version), `"./path"` / `"../path"`
 *     (local path).
 *   - **SourceSpec table** — `{ npm = "..." }` or `{ path = "..." }`.
 *     Inline; auto-installs.
 *
 * Shape classification is done at parse time; resolution against the
 * appropriate tables happens later.
 */
export type Reference = string | SourceSpec;

// ─── Providers ─────────────────────────────────────────────────────────────

/**
 * A `[providers].<handle>` entry. The value is just a `SourceSpec` (or
 * its string fast-path); providers don't carry boot-time config in v5 —
 * any configuration lives at the use site (`[harness]`, `[session]`,
 * `[tools.X]`) and reaches the contribution's `create()` as its
 * per-instance config.
 *
 * Stored shape after parse: the value is either a string fast-path
 * (we keep it as-is for round-trip fidelity) or a normalised
 * `SourceSpec` table.
 */
export type ProviderEntry = Reference;

/**
 * `[providers]` table. Optional; absent means no named provider
 * handles. Anonymous-instance sharing across multiple tools / slots
 * is handled implicitly by the resolver's `(source, config)` dedup.
 */
export type Providers = Record<string, ProviderEntry>;

// ─── Tools ─────────────────────────────────────────────────────────────────

/**
 * A `[tools.<key>]` entry. Two shapes accepted on disk:
 *
 *   - **Table with `provider`** — `provider` is a `Reference` (handle
 *     or inline source). Other keys are per-tool config (also passed
 *     to the resolved `Tools` instance as its config — sharing is
 *     keyed by `(source, config)`).
 *   - **String shorthand** — equivalent to `{ provider = "<string>" }`
 *     with no extra config. The common case for built-ins is
 *     `bash = "builtin"`.
 *
 * Empty `{}` is *not* a valid entry. Every table form must name a
 * `provider`; the string form is the no-config sugar. An entire
 * absent `[tools]` table still auto-loads the default builtin set
 * — see {@link AgentManifest.tools}.
 */
export type ToolEntry = string | ToolEntryTable;

export interface ToolEntryTable {
  provider: Reference;
  [configKey: string]: unknown;
}

// ─── Harness / Session ─────────────────────────────────────────────────────

/**
 * `[harness]` block. `provider` selects a harness contribution by:
 *
 *   - a built-in name (`"anthropic"`, `"openai"`, `"test"`),
 *   - a `[providers]` handle (the provider's primary harness
 *     contribution), or
 *   - an inline `Reference` to a SourceSpec (provider loaded inline).
 *
 * All other keys are per-instance config (model, base_url, …), passed
 * verbatim to the harness `create()` as `config`.
 */
export interface HarnessSpec {
  provider: Reference;
  [configKey: string]: unknown;
}

/** Same shape as `HarnessSpec`. Session is also a singleton per agent. */
export interface SessionSpec {
  provider: Reference;
  [configKey: string]: unknown;
}

// ─── Agent manifest (input shape) ──────────────────────────────────────────

export interface AgentManifest {
  /** Absolute path to the source file, if loaded from disk. */
  manifestPath?: string;
  name: string;
  description?: string;
  systemPrompt?: SystemPromptSpec;
  /** See {@link SecretAllowlist}. */
  secrets?: SecretAllowlist;

  /** Optional. Local handles for code sources referenced from below. */
  providers?: Providers;

  /**
   * Harness slot: either a `HarnessSpec` (resolved via `provider`) or
   * a pre-built `Harness` instance the runtime uses as-is. Detected
   * by presence of `provider` (instances do not carry one).
   */
  harness: HarnessSpec | Harness;

  /**
   * The agent's session. One of three forms:
   *
   *   - **Singleton** — a single `SessionSpec`. TOML form is
   *     `[session]` with a `provider` field. The trivial one-layer
   *     session.
   *   - **Layered** — a `SessionSpec[]` describing a composition,
   *     outer-to-inner. TOML form is `[session]` with a `layers`
   *     array (or the dotted-key array-of-tables
   *     `[[session.layers]]`). `push` flows top-to-bottom, `pull`
   *     flows bottom-to-top; other hooks (`tools`, `prepareTurn`,
   *     `systemPromptSection`, etc.) aggregate across layers.
   *   - **Pre-built instance** — a constructed `Session` the runtime
   *     uses directly. Bypasses manifest resolution; useful when you
   *     want a direct reference to the underlying layers from SDK
   *     code.
   *
   * Absent → runtime uses the default chain `skills → compacting →
   * memory` (skills silently no-op when `~/.skills` is missing).
   */
  session?: SessionSpec | SessionSpec[] | Session;

  /**
   * Top-level tools, model-facing name → entry. Absent → loom
   * auto-loads the default builtin set (`bash`, `read_file`,
   * `write_file`, `find`) with default capabilities. Present (even
   * empty) → exactly what's listed; no defaults.
   */
  tools?: Record<string, ToolEntry>;

  /**
   * See {@link Capabilities}. Tools whose `requires` aren't satisfied
   * fail boot. Grants are a transitive ceiling across the subagent
   * tree — see §1.6 of manifest-v5.md.
   */
  capabilities?: Capabilities;
}
