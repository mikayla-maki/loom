// `import type` is erased at compile time, so the manifest ↔ interfaces cycle is safe.
import type { Harness, Session } from "./interfaces.js";

export type SystemPromptSpec = string | { path: string };

export type CapabilityValue =
  | "*"
  | string
  | number
  | boolean
  | unknown[]
  | Record<string, unknown>;

export type CapabilityGrant = Record<string, CapabilityValue>;

/**
 * A grant for one tool. `"*"` is unrestricted; an array is a row set, and a
 * request is authorized iff it fits entirely within some single row.
 */
export type CapabilitySet = "*" | CapabilityGrant | CapabilityGrant[];

export type Capabilities = Record<string, CapabilitySet>;

export type SecretAllowlist = "*" | string[];

export type SourceSpec =
  | { npm: string; version?: string }
  | { path: string; subpath?: string };

export type Reference = string | SourceSpec;

export type ProviderEntry = Reference | ProviderEntryTable;

export interface ProviderEntryTable {
  provider: Reference;
  [configKey: string]: unknown;
}

export type Providers = Record<string, ProviderEntry>;

export type ToolEntry = string | ToolEntryTable;

/**
 * A tool entry selects, names, and authorizes — it never configures;
 * construction config belongs on the thing being constructed. The instance
 * key is the model-facing tool name.
 */
export interface ToolEntryTable {
  /**
   * Implementation reference: "builtin", "session", a `[providers]` handle,
   * a bare SourceSpec, or an inline configured `[providers]` entry. Required
   * in a manifest; a contributed entry may omit it to match an existing instance.
   */
  provider?: Reference | ProviderEntryTable;
  /** Underlying tool name when the instance key is a rename. */
  tool?: string;
  /**
   * Requested grant; defaults to the full ceiling entry for the instance
   * (or underlying) name. Every request must be contained by the ceiling.
   */
  capabilities?: CapabilitySet;
}

export interface HarnessSpec {
  provider: Reference;
  [configKey: string]: unknown;
}

export interface SessionSpec {
  provider: Reference;
  [configKey: string]: unknown;
}

export type SessionLayerEntry = SessionSpec | Session | string;

/**
 * A labeled `[tools]` table contributed by a session layer, judged against
 * the agent's capability ceiling: accepted atomically or rejected with
 * per-declaration verdicts. Producers must emit fully-resolved values.
 */
export interface ToolGroup {
  /** Provenance shown in audit and boot reports, e.g. `skill 'calendar'`. */
  label: string;
  tools: Record<string, ToolEntry>;
  /**
   * Group-local provider table; handles are lexical to this group and
   * substituted before resolution. Entries resolving to a contributed
   * source require explicit instance-name acceptance in `[capabilities]`.
   */
  providers?: Providers;
}

export interface DeclarationVerdict {
  instance: string;
  underlying: string;
  ok: boolean;
  /** The ceiling key the request was judged against, if any. */
  against?: string;
  reason?: string;
  /** Paste-ready `[capabilities]` TOML when the request was not granted. */
  remediation?: string;
}

export interface ToolGroupVerdict {
  label: string;
  accepted: boolean;
  declarations: DeclarationVerdict[];
}

export interface AgentManifest {
  manifestPath?: string;
  name: string;
  description?: string;
  systemPrompt?: SystemPromptSpec;
  secrets?: SecretAllowlist;
  storageId?: string;
  providers?: Providers;
  harness: HarnessSpec | Harness;
  session?: SessionSpec | SessionLayerEntry[] | Session;
  tools?: Record<string, ToolEntry>;
  capabilities?: Capabilities;
  metadata?: Record<string, unknown>;
}
