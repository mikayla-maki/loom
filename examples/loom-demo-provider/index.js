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
const PROVIDER_NAME = "loom-demo-provider";
function readEchoConfig(raw) {
    const c = (raw ?? {});
    return {
        prefix: typeof c.prefix === "string" ? c.prefix : "echo>",
    };
}
function readTaggedMemoryConfig(raw) {
    const c = (raw ?? {});
    return {
        tag: typeof c.tag === "string" ? c.tag : "demo",
    };
}
function readEchoInput(raw) {
    const c = (raw ?? {});
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
export function register(api) {
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
        create(instanceConfig) {
            const { prefix } = readEchoConfig(instanceConfig);
            return {
                resolveTool(name) {
                    const tool = {
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
                        async execute(input) {
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
        create(config) {
            const { tag } = readTaggedMemoryConfig(config);
            const events = [];
            return {
                async push(event) {
                    events.push(event);
                    return [event];
                },
                async pull(below) {
                    // Concatenate persisted events with anything an outer
                    // wrapper produced. The outer wrapper (if any) sees the
                    // session's view; in the simplest case, `below` is empty.
                    return [...events, ...below];
                },
                // This is what makes the demo visible: the assembled system
                // prompt gains a `Memory tag:` line, so a user prompting the
                // agent can verify the session is actually wired in.
                systemPromptSection() {
                    return `Memory tag: ${tag}`;
                },
                async close() {
                    /* nothing to release */
                },
            };
        },
    });
}
