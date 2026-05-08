# Session — design notes

## Where we landed

The `Session` interface keeps its durable-log core (`append`,
`getEvents`, `count`) and grows two **per-turn hooks**, each of which
receives a fresh `SessionContext` as an argument:

```ts
export interface Session {
  // unchanged
  append, getEvents, count, skills?, list?, resume?, close?;

  /** Loom calls this once per turn, after the user message has been
   *  appended and before the runtime is built. The session does any
   *  work that needs the harness here — most importantly compaction. */
  prepareTurn?(ctx: SessionContext): Promise<void> | void;

  /** Returns the system-prompt section to splice into the assembled
   *  prompt. Called per turn, after prepareTurn. */
  systemPromptSection?(ctx: SessionContext): string | Promise<string>;
}

export interface SessionContext {
  harness: Harness;
  systemPromptCore: string;
  agentName: string;
  agentDescription?: string;
}
```

**Pass at time of use, not at boot.** Earlier drafts had a
`bindContext(ctx)` call at boot that the session stashed. We dropped
that pattern: state-at-a-distance is a footgun, and there's no
real-world use case where the session needs the context outside of a
turn anyway. The hook gets the context as an argument.

**The harness is exposed directly.** Not a narrow wrapper. Loom is
self-similar: a session that wants to summarise calls
`summarise(ctx.harness, ...)`; a session that wants RLM-style
sub-agents builds them with `runAgent({ harness: ctx.harness, ... })`,
inheriting secrets and configuration for free because the harness
instance closes over them.

## Harness as the lab boundary

Harness's job is to abstract a provider, including its quirks. It
already had `run()`. It now also has an optional `summarise()` for
labs with native or near-native summarisation endpoints. More may
follow (`embed`, `classify`, parallel-tool-call hints, etc.); each
earns its place when there's a clear cost/perf/quality win over
composing `run()`.

Loom ships free fallbacks for any non-native lab method. `summarise`
falls back to `summariseViaRun(harness, args)` — drives a tool-free
turn through `run()` and collects the assistant text. So sessions
never branch on "is this method present?"; they just call the
top-level helper:

```ts
const summary = await summarise(ctx.harness, { events, instruction, systemPrompt });
```

## System prompt, four sources

Loom owns assembly. The order is now:

1. **Manifest core** — `[agent].system_prompt` (the identity layer).
2. **Skills** — auto-generated catalogue.
3. **Tool reference** — auto-generated.
4. **Ambient context** — current date.
5. **Session section** — what the session contributes via
   `systemPromptSection(ctx)`. Lands at the very end so retrieved
   memories sit closest to the conversation history (model recency
   bias works in our favour).

The session section is recomputed per turn. Memory implementations
can do per-turn retrieval; freshly-retrieved facts land for the
current message.

## Compaction

`CompactingSession` is the canonical example of a session that needs
the harness. The flow is:

1. `append(update)` — store; no side effects.
2. `prepareTurn(ctx)` — if `count >= threshold`, call the configured
   `Compactor` with the slice and `ctx`. The compactor returns
   replacement events; we splice.
3. The default compactor is heuristic (no model, no API spend). The
   `modelCompactor()` factory uses `summarise(ctx.harness, ...)` for
   model-written prose summaries; falls back to heuristic if
   `ctx === null` (standalone use, e.g. tests calling `compactNow()`
   without a context).

## What's next

- **RLM sessions.** The interface supports them today: a session that
  wants a sub-agent calls `runAgent({ harness: ctx.harness, ... })`
  inside `prepareTurn` or a tool's `execute()`. We haven't shipped one
  yet; the minimal shape would be a memory-search sub-agent with its
  own append-only session. Two sub-agent ergonomics are still missing
  for production use:
  - **Secret-store flow-through.** Today the harness instance carries
    its own API key, so the sub-agent's harness works. But if the
    sub-agent's tools need *additional* secrets (e.g. Discord token),
    those don't propagate. Fix: `runAgent` accepts a parent
    `SecretsStore` in `RunAgentOptions`, used as the front of the
    chain.
  - **Permission handler flow-through.** Tools call
    `ctx.requestPermission()`; the parent's handler should answer for
    the sub-agent too. Fix: `runAgent` accepts a parent
    `PermissionHandler`, used as the default.
- **Memory sessions.** The pieces are in place: `prepareTurn` for
  retrieval, `systemPromptSection` for injection, `ctx.systemPromptCore`
  + `ctx.agentName` for identity-aware scoping.
- **More lab methods.** `embed`, `classify`, etc. earn their place
  when there's a real win.
