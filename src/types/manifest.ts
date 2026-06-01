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

export type CapabilitySet = "*" | Record<string, CapabilityValue>;

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

export interface ToolEntryTable {
  provider: Reference;
  [configKey: string]: unknown;
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
