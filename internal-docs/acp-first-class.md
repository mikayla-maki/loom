# ACP First-Class Support

> Status: design, awaiting implementation.

What's missing today, and what to add, so a stock ACP client (Zed,
OpenClaw, ...) can drive a Loom agent without any Loom-specific
adapters.

## What we already have

The wire infrastructure is in place — see `src/acp/`:

- **JSON-RPC 2.0 framing** over ndjson (`framing.ts`).
- **Stdio transport** via the SDK's `AgentSideConnection` + `ndJsonStream`
  (`src/acp/server.ts`). There used to be Unix/TCP transports and an
  `acp://` URL scheme; both were daemon-mode artefacts and have been
  removed.
- **`LoomAcpAgent`** (inside `server.ts`) multiplexes sessions over one
  connection
  (`server.ts`), handling:
  - `session/new` — start a session against a manifest
  - `session/prompt` — drive a turn, return a final string + usage
  - `session/cancel` — abort in-flight turn
  - `session/close` — release session resources
  - `session/update` (notifications, agent → client) — streams agent
    output as `SessionUpdate` events
  - `session/request_permission` (agent → client request) — bridges
    `ToolContext.requestPermission` to the connected client

What's tested round-trips through stdio (in-process pipes) and
subprocess (actual `loom acp serve`).

## What's missing

Three things, in priority order:

1. **`initialize` handshake.** Every ACP-compliant client sends
   `initialize` first to negotiate capabilities. Loom currently
   accepts `session/new` cold — which means a real client connecting
   to a Loom agent sees an error before anything useful happens.

2. **Capability aggregation.** Loom is composed: harnesses know about
   streaming/thinking; sessions know about resume/history; tools
   contribute their schemas. Right now there's no way for a session or
   harness to *advertise* its ACP capabilities. The aggregated set is
   what gets sent back to the client in `initialize`'s response.

3. **`session/load`** — ACP's resume entry point. Maps cleanly onto
   `Session.resume?(id)` which already exists in the interface; just
   needs a router method.

Optional / out of scope for v1 of this work:

- **`fs/*` extensions** — read/write files through the client.
  Requires plumbing through `read_file` / `write_file` tools. Useful
  for sandboxed clients (Zed can mediate file access on the editor's
  behalf). Defer.
- **`terminal/*` extensions** — similar story for bash. Defer.

## Design: the `initialize` handshake

### Wire shape

```
client → agent (request):
{
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": { "readTextFile": true, "writeTextFile": false },
      "terminal": false,
      "permissions": true
    },
    "clientInfo": { "name": "zed", "version": "0.123" }
  }
}

agent → client (response):
{
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "streaming": true,
      "thinking": false,
      "toolCalls": true,
      "permissions": true,
      "loadSessions": true
    },
    "agentInfo": {
      "name": "my-agent",
      "description": "...",
      "loomVersion": "0.2.0"
    }
  }
}
```

Field names follow ACP draft conventions (camelCase, mirrored
`clientCapabilities` / `agentCapabilities`). Loom's version isn't tied
to ACP's version; we negotiate `protocolVersion: 1` and reject other
values cleanly.

### What goes into `agentCapabilities`

A flat, typed object. Each field is the answer to "does this agent
support X?" — derived by aggregating across the agent's parts.

| Field | Meaning | Derived from |
|---|---|---|
| `streaming` | Emits `agent_message_chunk` events as text generates. | `Harness.acpCapabilities?().streaming` — defaults to `true`. |
| `thinking` | Emits `agent_thought_chunk` events. | `Harness.acpCapabilities?().thinking` — defaults to `false`. |
| `toolCalls` | Emits `tool_call` / `tool_call_update` events. | Always `true` (Loom's runtime emits them). |
| `permissions` | Issues `session/request_permission` mid-turn. | Always `true`. |
| `loadSessions` | Accepts `session/load` to resume a prior session id. | `Session.resume` is defined on the configured session. |
| `experimental` | Open bucket for non-spec capabilities. | Aggregated from `acpCapabilities?().experimental`. |

The `experimental` bag is the extension point: a session can advertise
`{ experimental: { "loom.skills": true } }` and a Loom-aware client
can detect and use it. No spec changes needed.

### Aggregation rules

```typescript
function aggregateAcpCapabilities(agent: {
  harness: Harness;
  session: Session;
}): AgentAcpCapabilities {
  const fromHarness = agent.harness.acpCapabilities?.() ?? {};
  const fromSession = agent.session.acpCapabilities?.() ?? {};
  return {
    streaming: fromHarness.streaming ?? true,
    thinking: fromHarness.thinking ?? false,
    toolCalls: true,
    permissions: true,
    loadSessions: typeof agent.session.resume === "function",
    experimental: { ...fromHarness.experimental, ...fromSession.experimental },
  };
}
```

Booleans use a precedence chain (harness for compute-side caps,
session for memory-side caps); booleans default to the safest value
when nothing claims them.

### What loom does with `clientCapabilities`

For v1, mostly nothing — we record them on the session for future
use. The one exception is **`clientCapabilities.permissions`**: if
the client doesn't claim it, the router falls back to "deny all
permission requests" instead of bridging to the client (saves a
round-trip that we know would fail).

Later, `clientCapabilities.fs.readTextFile === true` would let the
runtime route `read_file` tool calls through the client; that's the
optional fs extension noted above.

## Design: interface additions

In `src/types/interfaces.ts`:

```typescript
/**
 * What an agent component (harness/session) can do at the ACP layer.
 * All fields optional; aggregation picks reasonable defaults.
 */
export interface AcpCapabilityContribution {
  streaming?: boolean;
  thinking?: boolean;
  experimental?: Record<string, unknown>;
}

export interface Harness {
  // existing fields...
  acpCapabilities?(): AcpCapabilityContribution;
}

export interface Session {
  // existing fields...
  acpCapabilities?(): AcpCapabilityContribution;
}
```

Both methods are optional; absent means "I have no specific
contribution." Loom aggregates and fills in safe defaults.

## Design: `session/load`

Maps directly onto `Session.resume?(id)`:

```
client → agent:
{
  "method": "session/load",
  "params": { "sessionId": "<existing>" }
}

agent → client:
{
  "result": { "sessionId": "<existing>", "agentName": "..." }
}
```

The router calls `agent.session.resume(id)` — if it returns a
`Session`, the router rebinds the running agent's session and returns
the same `sessionId`. If the session doesn't implement `resume`, the
router returns method-not-found. Errors during resume bubble up as
JSON-RPC error responses.

## Implementation plan

Three steps, each independently mergeable:

### Step 1: types + aggregation

- Add `AcpCapabilityContribution` to `types/interfaces.ts`.
- Add optional `acpCapabilities?()` to `Harness` and `Session`.
- Add a small `runtime/acp-capabilities.ts` with the aggregation function.
- Tests: aggregation under various harness/session combinations.

### Step 2: `initialize` method

- Add `initialize` to `ACP_METHODS` and a corresponding message type pair.
- Add `handleInitialize()` to `AcpRouter`.
- Stash `clientCapabilities` on a per-stream record so subsequent
  routing decisions (permission fallback, future fs extensions) can
  read it.
- Add `clientInfo` capture for logging.
- Tests: round-trip initialize over in-process streams; check
  aggregated capabilities reflect the contributing parts.

### Step 3: `session/load`

- Add `session/load` to methods + message types.
- Add `handleSessionLoad()` to `AcpRouter` that delegates to
  `agent.session.resume?(id)`.
- Tests: load → prompt against a session backend that supports
  resume.

## Migration

This is purely additive — no existing behaviour changes. Existing
tests should pass unchanged.

## Out of scope (defer)

- `fs/*` extensions (route `read_file` etc. through the client).
  Requires changes to tool implementations. Big enough for its own
  design doc.
- `terminal/*` extensions.
- `authenticate` method (most clients don't require it for stdio).
- Protocol-version negotiation beyond accept/reject. Loom advertises
  v1; clients on a different major version get a clean error rather
  than a degraded session.
