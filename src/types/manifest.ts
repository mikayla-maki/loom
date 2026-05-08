/**
 * Manifest types — the shape of an agent definition, whether parsed from
 * disk (agent.toml) or constructed in memory by an SDK consumer.
 *
 * The manifest carries unresolved references: tool entries are
 * `(name, config)` pairs that loom routes through the provider chain
 * to produce `Tool` objects. There's no on-disk tool format — tools
 * are JS code that an extension (or loom's native provider) registers.
 *
 * ─── Three axes (v2) ──────────────────────────────────────────────────
 *
 * An agent is composed along three orthogonal axes:
 *
 *   1. INSTALLATION — `[extensions]` declares npm packages that register
 *      providers, harnesses, and sessions. The native provider always
 *      ships with Loom. This axis answers "where does the code come
 *      from?"
 *
 *   2. WIRING — `[tools]` maps a model-facing name to a `(provider,
 *      config)` pair. Loom asks each provider in turn whether it claims
 *      the name; first non-null wins. The config is the tool's own
 *      runtime defaults (region, timeouts, server URL) — it does NOT
 *      carry capability grants.
 *
 *   3. GRANT — `[capabilities]` says what each named tool may do, in a
 *      tool-defined shape. Loom hands the grant to the tool at
 *      construction time; the tool self-polices on every dispatch and
 *      derives its model-facing description / input schema from what
 *      it was granted. (A single-bucket grant binds the bucket; a
 *      multi-bucket grant exposes an enum; an unrestricted grant opens
 *      the full surface.)
 *
 * Plus a fourth, secret-axis allowlist on `[agent].secrets`: an
 * upper bound on the secret names tools may resolve from the secret
 * store chain.
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

// ─── Capabilities (v2) ──────────────────────────────────────────────────────

/**
 * The value granted to a single capability KIND (e.g. `paths`,
 * `subprocess`, `buckets`). Either:
 *   - `"*"`           — that kind is unrestricted
 *   - `unknown[]`     — kind-defined allowlist (most commonly string[])
 *   - `Record<...>`   — structured value (rare; reserved for kinds that
 *                       want richer arguments than a flat allowlist)
 *
 * Absence of the kind from a `CapabilitySet` means denied.
 */
export type CapabilityValue = "*" | unknown[] | Record<string, unknown>;

/**
 * The full grant for one tool: either `"*"` (whole tool unrestricted —
 * every kind allowed; sandbox engagement opts out), or a per-kind map.
 * Empty `{}` grants nothing; tools with non-empty `requires` will fail
 * boot.
 */
export type CapabilitySet = "*" | Record<string, CapabilityValue>;

/**
 * The agent's per-tool grant table. Keyed by the tool's manifest name
 * (the same key used in `[tools]`).
 */
export type Capabilities = Record<string, CapabilitySet>;

/**
 * Secret allowlist on `[agent].secrets`. Same star-or-list semantics
 * as capabilities:
 *   - absent or `"*"` → no ceiling, any secret name a tool wants may
 *                       resolve
 *   - `[]`            → no secrets at all
 *   - `["A", "B"]`    → only these names may resolve
 *
 * Boot guard: every tool's `Tool.secrets.required ∪ optional` must be
 * a subset of this allowlist when the array form is set.
 */
export type SecretAllowlist = "*" | string[];

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
  /**
   * Allowlist of secret names tools in this agent may resolve. Mirrors
   * `[capabilities]` star-or-list semantics; see {@link SecretAllowlist}.
   */
  secrets?: SecretAllowlist;
  harness: HarnessSpec;
  /** Optional. Defaults to `{ provider: "memory" }` if absent. */
  session?: SessionSpec;
  /**
   * Per-tool capability grant. Keyed by the same name used in `[tools]`.
   * Each value is `"*"` (whole tool unrestricted) or a per-kind map.
   * Tools whose `requires` aren't satisfied by their grant fail boot.
   */
  capabilities?: Capabilities;
  /**
   * Top-level tools — model-facing name → tool config. Loom routes each
   * `(name, config)` pair through the provider chain. The native
   * provider claims known builtin names; extension providers claim
   * names they register.
   *
   * Capabilities do NOT live here; they live in the parallel
   * `[capabilities]` table. The config carried here is the tool's own
   * runtime defaults (region, timeouts, server URL, provider hint).
   *
   * Semantics:
   *   - field absent       → loom auto-loads the default builtin set
   *                          (`bash`, `read_file`, `write_file`, `find`)
   *                          with default capabilities.
   *   - field present (any) → exactly what's listed; no defaults.
   *   - empty table        → no top-level tools at all.
   */
  tools?: Record<string, ToolConfig>;
  /**
   * Extensions: npm packages with a `loom.extension` field, loaded at boot.
   * Each entry's name is the package name; the value is the config object
   * passed to the package's `register()` function.
   */
  extensions?: Record<string, Record<string, unknown>>;
}
