/**
 * Example Loom provider — contributes two things to demonstrate the
 * full surface area:
 *
 *   1. A **Tools registration** for an `echo`-style tool (configurable
 *      prefix).
 *   2. A **session contribution** that wraps in-memory storage and
 *      tags every event with a configurable label (visible in the
 *      assembled system prompt).
 *
 * This is the TypeScript source. `tsc` compiles it to `./index.js`,
 * which is what `package.json`'s `loom.provider` field points at and
 * what Loom imports at runtime.
 *
 * Providers can also contribute harness contributions via
 * `api.registerHarness(...)` — omitted here because harnesses are
 * substantial (they implement an LLM API loop).
 *
 * v5 convention: register your primary contribution of each kind
 * (Tools, harness, session) under the package's name. That's what
 * lets the manifest reference the provider by its `[providers]`
 * handle without having to know what name the provider picked
 * internally.
 */

import type { LoomProviderApi } from "../../src/providers/loader.js";
import type { Session, Tool, Tools } from "../../src/types/interfaces.js";
import type { SessionUpdate } from "../../src/types/acp.js";

const PROVIDER_NAME = "loom-demo-provider";

// ─── Tools-registration config ────────────────────────────────────────────

/**
 * Per-instance config the manifest passes to the echo Tools
 * registration.
 *
 * Loom passes the full config blob to `create()` as `unknown`; the
 * provider's responsibility is to validate the shape it cares about
 * and ignore anything else. If we wired up a `configSchema`, Loom
 * would do the shape check for us before calling `create()`.
 */
interface EchoToolsConfig {
  /** Prefix prepended to every echoed string. Defaults to `"echo>"`. */
  prefix?: string;
}

function readEchoConfig(raw: unknown): Required<EchoToolsConfig> {
  const c = (raw ?? {}) as Record<string, unknown>;
  return {
    prefix: typeof c.prefix === "string" ? c.prefix : "echo>",
  };
}

// ─── Session-contribution config ──────────────────────────────────────────

interface TaggedMemoryConfig {
  /** Label that appears in the assembled system prompt. */
  tag?: string;
}

function readTaggedMemoryConfig(raw: unknown): Required<TaggedMemoryConfig> {
  const c = (raw ?? {}) as Record<string, unknown>;
  return {
    tag: typeof c.tag === "string" ? c.tag : "demo",
  };
}

// ─── Tool input shape ────────────────────────────────────────────────────

interface EchoToolInput {
  text: string;
}

function readEchoInput(raw: unknown): EchoToolInput {
  const c = (raw ?? {}) as Record<string, unknown>;
  return {
    text: typeof c.text === "string" ? c.text : "",
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────

/**
 * Called once by the host runtime when the manifest references this
 * provider's source. Registering happens here; instantiation is
 * deferred until the manifest asks for it.
 */
export function register(api: LoomProviderApi): void {
  // ─── 1. Tools contribution ──────────────────────────────────────
  // The Tools instance claims *any* tool name the manifest gives it.
  // That lets the manifest pick the user-facing name (`echo`,
  // `shout`, `whisper`) while the provider only owns the behaviour.
  // Each configured instance can carry its own `prefix`, so two
  // tools referencing this provider with different prefixes look
  // like distinct verbs to the model. Sharing follows from the
  // runtime's `(source, config)` dedup.
  api.registerTools({
    name: PROVIDER_NAME,
    create(instanceConfig: Record<string, unknown>): Tools {
      const { prefix } = readEchoConfig(instanceConfig);
      return {
        resolveTool(name: string): Tool {
          const tool: Tool = {
            name,
            description: `Echo input back, prefixed with ${JSON.stringify(prefix)}.`,
            inputSchema: {
              type: "object",
              required: ["text"],
              additionalProperties: false,
              properties: {
                text: {
                  type: "string",
                  description: "The text to echo.",
                },
              },
            },
            async execute(input: unknown) {
              const { text } = readEchoInput(input);
              return { content: `${prefix} ${text}` };
            },
          };
          return tool;
        },
        async close() {
          /* nothing to release */
        },
      };
    },
  });

  // ─── 2. Session contribution ────────────────────────────────────
  // A simple in-memory session that prepends a banner to the system
  // prompt naming its `tag` config. Demonstrates how sessions can
  // contribute to the prompt without involving the tool surface.
  api.registerSession({
    name: PROVIDER_NAME,
    create(config: Record<string, unknown>): Session {
      const { tag } = readTaggedMemoryConfig(config);
      const events: SessionUpdate[] = [];

      return {
        async push(event: SessionUpdate): Promise<SessionUpdate[]> {
          events.push(event);
          return [event];
        },
        async pull(below: SessionUpdate[]): Promise<SessionUpdate[]> {
          // Concatenate persisted events with anything an outer
          // wrapper produced. The outer wrapper (if any) sees the
          // session's view; in the simplest case, `below` is empty.
          return [...events, ...below];
        },
        // This is what makes the demo visible: the assembled system
        // prompt gains a `Memory tag:` line, so a user prompting the
        // agent can verify the session is actually wired in.
        systemPromptSection(): string {
          return `Memory tag: ${tag}`;
        },
        async close() {
          /* nothing to release */
        },
      };
    },
  });
}
