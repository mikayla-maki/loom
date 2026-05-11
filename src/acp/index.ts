/**
 * ACP server adapter — thin wrapper over `@agentclientprotocol/sdk`'s
 * `AgentSideConnection`. This is the only ACP surface Loom needs:
 * `loom acp serve <agent.toml>` wires `serveOverStdio` to stdin/stdout
 * and the SDK owns everything else.
 *
 * There is intentionally no client surface here. Loom is an *agent*;
 * when something needs to play the client role (the round-trip test,
 * a third-party embedder), it talks to `ClientSideConnection` from
 * the SDK directly.
 */

export {
  ACP_PROTOCOL_VERSION,
  serveOverStdio,
  serveOverStream,
} from "./server.js";
