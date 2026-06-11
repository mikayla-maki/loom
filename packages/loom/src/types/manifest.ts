// The spec-form manifest types live in the capabilities package; this
// module adds the SDK instance forms (a pre-built Harness/Session in the
// manifest object), which only exist at runtime.
import type { Harness, Session } from "./interfaces.js";
import type {
  Capabilities,
  HarnessSpec,
  Providers,
  SecretAllowlist,
  SessionSpec,
  SystemPromptSpec,
  ToolEntry,
} from "@mcmaki/loom-capabilities";

export type {
  AgentManifestFile,
  Capabilities,
  CapabilityGrant,
  CapabilitySet,
  CapabilityValue,
  DeclarationVerdict,
  GrantAlgebra,
  HarnessSpec,
  ManifestFragments,
  ProviderEntry,
  ProviderEntryTable,
  Providers,
  Reference,
  SecretAllowlist,
  SessionSpec,
  SourceSpec,
  SystemPromptSpec,
  ToolEntry,
  ToolEntryTable,
  ToolGroup,
  ToolGroupSource,
  ToolGroupVerdict,
} from "@mcmaki/loom-capabilities";

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
