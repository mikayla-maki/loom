# Session — testbed notes

Field notes from building the sample CLI. The current `Session` interface
(`src/types/interfaces.ts`) is the durable-log shape: `append`,
`getEvents`, `count`, optional `skills()` and `list/resume/close`. Two
in-tree impls (`memory`, `file`); a third (`compacting`) is the first
session whose semantics aren't just "remember everything I'm told."

This document records the friction discovered while wiring the
compacting session into the sample CLI, and sketches where the
interface might need to grow.

## What worked unchanged

The compacting session, in its **heuristic** form, fits the existing
interface cleanly:

- It implements `append`/`getEvents`/`count`.
- Compaction is a private side-effect of `append`: when the in-memory
  log crosses a threshold, older events are replaced with a synthetic
  user→agent pair.
- `getEvents()` remains the harness's view of conversation history; the
  harness doesn't know or care that some events are summaries.

So for *content-free* compaction (one-line-per-event recap, rule-based
filtering, etc.), no interface changes are needed. The Session is free
to rewrite its own contents as long as it preserves tool_call/
tool_call_update pairing.

## Where it starts to bend

Three things became awkward as soon as I tried to imagine
**model-driven** compaction:

1. **The session needs a model.** A summarising compactor wants to
   drive a model turn — system-prompt + the slice to summarise + a
   "produce a tight summary" instruction. There's no path from the
   session to the harness today. Three plausible shapes:

   a. *Setter on Session.* Add an optional
      `bindRuntime?(rt: SessionRuntime): void` and have `runAgent` call
      it post-init. `SessionRuntime` exposes a `summarise(events,
      instruction)` primitive (or just hands over the harness). Keeps
      Session a passive object; the runtime drives.

   b. *Session contributes a tool + a skill.* The session's
      `skills()` hook returns a `compactor` skill whose `requires:`
      points at a `compact` tool. The session's `append` decides
      when to compact and *signals* by emitting a synthetic
      `tool_call` for `compact`; the model loop picks it up. Honest
      to who's deciding (the session) but uses the regular dispatch
      path. Clunky because synthesizing tool_use blocks isn't
      something today's harnesses know how to do.

   c. *Runtime-driven.* Session exposes `shouldCompact(): boolean`;
      the harness checks before each turn; when set, the harness
      pauses, calls the model with a session-provided prompt, splices
      the result into the session, then proceeds. Pushes the policy
      out to the harness, which doesn't feel right either.

   The current bias is **(a)**: keep Session in charge of its own
   lifecycle, give it a thin runtime handle. That handle is small and
   testable, and it's the same shape that other Session features
   would want (e.g. "session decides to evict an extension's tool
   when it goes idle" → it'd want the same tool/runtime references).

2. **The harness instance isn't exposed.** `RunningAgentImpl` builds a
   harness in the constructor and stores it privately. There's no
   `agent.harness` getter. For a Setter-based design, `runAgent` would
   need to pull the harness out of the spec and hand it to the session
   *before* returning — which is mechanically fine (it's all
   happening inside `runAgent`), it's just a small refactor.

3. **The system prompt isn't reachable.** The harness gets it via
   `runtime.systemPrompt()`; the session never sees it. A summarising
   compactor probably wants the same prompt the agent normally runs
   under, plus a delta ("you are now summarizing rather than
   responding"). The fix is to thread the systemPromptCore through
   `bindRuntime` too.

## What I think the next interface looks like

A minimal, additive change:

```ts
// New: a primitive the session can use mid-run.
export interface SessionRuntime {
  /** Drive a one-shot model turn with an explicit prompt + events.
   *  Returns the final assistant text. Doesn't write to the session. */
  summarise(args: {
    events: SessionUpdate[];
    instruction: string;
  }): Promise<string>;

  /** The agent's normal system prompt core. */
  systemPromptCore: string;
}

export interface Session {
  // ...existing methods unchanged...

  /** Optional: receive a runtime handle. Called once at boot, after the
   *  harness is constructed but before the first prompt. */
  bindRuntime?(rt: SessionRuntime): void;
}
```

`summarise` would live in a small adapter that wraps the harness — it
builds a synthetic `Runtime` whose `getEvents()` returns just the slice,
runs the harness, and collects the agent_message_chunks. (Or, if the
harness has a streaming/text-only mode, calls that directly.)

Alternatively — and this is the form the prompt hinted at — Session
could just be handed the `Harness` instance directly, and the
`summarise` adapter is a utility we ship alongside it. That's slightly
less abstract but doesn't require a new wire type.

## What the current testbed doesn't tell us

- **Multi-session shapes.** `list/resume` are unused. The compacting
  session is fine without them; whether they belong on `Session` or on
  a separate `SessionStore` is a question the testbed didn't surface.
- **Ordered tool-call semantics during compaction.** Today
  `adjustForToolPairs` only cares about pair completion. A real-world
  compactor may want to preserve more (e.g. last *N* tool results
  verbatim because the model is mid-task). The test hook
  (`compactor` callback) lets a consumer encode this; we haven't
  needed to.

## Next step

The proposed move:

1. Add `bindRuntime` to `Session` (optional).
2. In `runAgent`, after instantiating the harness, build a
   `SessionRuntime` adapter and call `session.bindRuntime?.(rt)` before
   returning the running agent.
3. Add a `modelCompactor` factory in `compacting.ts` that uses the
   bound runtime (and falls back to the heuristic when not bound).
4. The CLI just wires it up.

Order suggests one commit for the interface change + scaffolding, one
for `modelCompactor`. Streaming is independent and earns its own commit.
