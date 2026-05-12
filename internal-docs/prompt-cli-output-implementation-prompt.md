# Improve `loom prompt` Output

A self-contained kickoff prompt. Pass this to a fresh session along
with the repo to do the work.

---

## Context

`loom prompt` is the non-interactive sibling to `loom run`. It runs
one turn against a manifest and exits. Two real audiences:

- **CI / scripts / pipelines.** Want clean text to pipe somewhere.
  `answer=$(loom prompt agent.toml "extract the date from this email")`
  should just work, like every other Unix CLI.
- **Quick local debug.** Want to see what happened — tool calls,
  reasoning, stop reason.

Today it does neither well. The current output is a chunk-by-chunk
trace:

```
[user] Hello there

[agent] Hello! How
[agent]  can I help you today?

[stop] end_turn
```

That's a streaming-protocol leak escaping the CLI layer (the two
`[agent]` lines should be one), and even if coalesced, the labels +
metadata are useless for the pipe-friendly use case.

The convention every other CLI converges on is **human-readable
text by default, structured output behind a `--format` flag.**
`gh`, `aws`, `curl`, `git` (`--porcelain`) all match this shape. We
should too.

### What this change ships

A `--format` flag with three modes:

1. **`text` (default).** Final agent message to stdout. Pipe-friendly.
   Tool calls, stop reasons, intermediate commentary all suppressed
   (or routed to stderr). The system prompt is quietly augmented to
   tell the agent it's running in this mode so it doesn't waste
   tokens on commentary the user will never see.
2. **`trace`.** Today's labeled view, but with messages **coalesced
   per turn** instead of emitted chunk-by-chunk. Includes tool calls
   and stop reasons for debug visibility.
3. **`jsonl`.** One `SessionUpdate` per line, raw ACP shape. For
   downstream consumers that want everything.

Plus exit codes that match Unix conventions for the various stop
reasons.

### Code state when you start

- The `loom prompt` command lives in `src/cli/`. Find the entry
  point and follow the imports.
- `src/cli/renderer.ts` has a `TextRenderer` that the current CLI
  uses. It's where the per-chunk `[agent] ...` lines come from.
  Will need refactoring or replacement.
- `agent.updates()` returns an async iterable of `SessionUpdate`
  events. The CLI subscribes to it and renders each event.
- `agent.prompt(text)` returns a `TurnResult` with the `stopReason`
  and `usage`.
- The full `SessionUpdate` union is in `src/types/acp.ts`. Relevant
  variants: `user_message_chunk`, `agent_message_chunk`,
  `agent_thought_chunk`, `tool_call`, `tool_call_update`, `stop`,
  `usage_update`.

---

## Design notes (already settled — don't re-litigate)

### "Final message only" semantics for `text` mode

The agent's turn can include multiple text segments interleaved
with tool calls: "Let me check..." → `tools/call` → "Here's the
result..." → another tool → "Final answer." Only the **last
contiguous block of `agent_message_chunk` events** (after the last
tool result, before `stop`) goes to stdout.

If the turn has no tool calls, that's the whole agent response.
If there are tool calls, we drop everything except the final
summary. The agent knows this is happening because of the prompt
augmentation below.

### System prompt augmentation for `text` mode

When running with `--format=text`, the CLI appends a short
explanation to the manifest's `systemPrompt` before booting:

> You are being invoked via `loom prompt` in text-output mode. Only
> your final message — the text after your last tool call, before
> the turn ends — is shown to the user. Any text before tool calls
> is invisible. Be concise; put the answer in your last message.

The manifest on disk is not modified. The augmentation lives in
memory only; it's appended to whatever the user wrote (or
defaulted) in `[agent].system_prompt`.

For `--format=trace` and `--format=jsonl`, the agent behaves
normally — no augmentation. Those modes show the full conversation.

### Rich content handling

ACP content blocks can be `text`, `image`, `audio`, or embedded
resources. For `text` mode:

- Text content blocks → joined into the stdout stream.
- Non-text content blocks → emit one line to **stderr**:
  `[image: image/png, 12.3 KB]` or similar. Don't silently swallow
  — the user might be confused why a "show me a chart" prompt
  produced no output.

For `jsonl` mode: emit verbatim. The consumer decides.

For `trace` mode: render text inline; show non-text as
`[image: ...]` placeholders inline.

### Exit codes

| Stop reason | Exit code |
|---|---|
| `end_turn` | 0 (normal completion) |
| `max_turns` | 1 (incomplete — agent hit the cap before finishing) |
| `cancelled` | 130 (SIGINT convention) |
| `error` | 1, error message to stderr |

Tool errors mid-turn don't fail the command — the agent may
recover. Only terminal stop reasons map to exit codes.

---

## Implementation plan

Two chunks. Both small and focused.

### Chunk 1: refactor + `--format=text` default

- Add a `--format <text|trace|jsonl>` flag to the `loom prompt`
  command. Default `text`.
- Refactor whatever's currently in `src/cli/` for `prompt`. The
  per-update label printer goes away (or moves to `trace` mode in
  Chunk 2). The new flow is:
  1. Parse `--format`.
  2. Load the manifest. If `--format=text`, append the system
     prompt augmentation to `manifest.systemPrompt` (or set it if
     undefined).
  3. Boot the agent via `runAgent`.
  4. Pump `agent.updates()` into a format-specific renderer.
  5. Call `agent.prompt(text)`.
  6. On completion, exit with the stop-reason-derived code.
- Implement the `text` renderer:
  - Track the "current agent message buffer." Append every
    `agent_message_chunk` to it.
  - On `tool_call` or `tool_call_update` arrival: clear the
    buffer. That tool result invalidates any text that came
    before it for output purposes.
  - On `stop`: emit the buffered text content to stdout. Emit
    non-text content blocks (from the same buffered message) as
    stderr `[image: ...]` placeholders.
  - Suppress everything else (tool calls, usage, thought chunks).
- Wire exit codes per the table above.
- Write tests in `test/cli-prompt.test.ts` (or wherever the
  CLI tests live):
  - No-tool turn: agent says "4", stdout is "4\n", exit 0.
  - Multi-segment turn with tools: agent says "Let me check..." →
    tool → "Result: 42." Only "Result: 42." reaches stdout.
  - `max_turns` stop reason → exit 1.
  - Rich content: image content block in final message → `[image:
    ...]` to stderr, text (if any) to stdout.
  - System prompt augmentation is applied: easiest way to test is
    to assert that the manifest passed to `runAgent` has the
    augmented prompt. Use a test harness with a script that
    captures its system prompt.

Verify with `npx tsc -p tsconfig.json --noEmit` + `npm test`.

### Chunk 2: `--format=trace` (coalesced) + `--format=jsonl`

- Implement the `trace` renderer:
  - Buffer chunks per message-id (or per "current agent run"
    since chunks don't carry message IDs in ACP).
  - Coalesce on the boundary between agent text and a tool call,
    OR on `stop`.
  - Output format:
    ```
    [user] check disk space
    [tool] bash {"command": "df -h"}
    [tool ✓] Filesystem  Size  Used  ...
    [agent] You have 32GB free.
    [stop] end_turn
    ```
  - Tool checkmarks: `✓` for `completed`, `✗` for `failed`, `…`
    for in-progress (shouldn't appear in a finished `prompt`
    output but defensive).
  - One stderr-summary line at the end with token usage when
    `usage_update` appeared: `[usage] 1234 in / 567 out`. Or
    skip if not present.
- Implement the `jsonl` renderer:
  - `console.log(JSON.stringify(update))` per event from
    `agent.updates()`. That's it.
  - No system prompt augmentation in this mode (agents behave
    normally; consumer parses what they want).
- Tests:
  - `trace`: multi-segment turn renders coalesced messages with
    tool labels.
  - `jsonl`: each event is one valid JSON line; piping through
    `jq` works (don't actually require jq in CI, just verify the
    shape).

---

## Working style

- **One chunk per response.** Stop after each with status.
- **Typecheck + tests must be clean** before moving on.
- **Don't break `loom run`.** It uses a different renderer entirely
  (the REPL); leave it alone.
- **The system prompt augmentation must be quiet.** No banner, no
  log line, no audit-output difference. The user runs `loom prompt`
  and gets the answer; the agent gets the nudge invisibly.

---

## Things to deliberately NOT do

- **No `--quiet` / `--verbose` flags.** Text mode is already quiet;
  trace mode is verbose. The format flag is the control.
- **No mixed output modes.** Don't try to be clever and emit both
  text-to-stdout AND trace-to-stderr by default. Pick one channel
  per mode.
- **No prompt template engine for the augmentation.** Hardcode the
  string. It's short, it's not user-facing, it doesn't need
  customization.
- **No retry / fallback on `max_turns` or `error`.** That's a
  policy the *agent* manages, not the CLI. CLI just reports the
  outcome via exit code.
- **No color in text mode.** It's pipe output. Trace mode can keep
  whatever color discipline the existing renderer uses.
- **No interactive prompts.** `loom prompt` reads stdin when no
  text argument is given, runs once, exits. No "continue?" loops.
- **Don't alter `agent.updates()` or any runtime types.** The
  changes are confined to `src/cli/`. The CLI is a consumer of
  the existing event stream; it doesn't need new event shapes.

---

## Definition of done

- `loom prompt agent.toml "2+2"` prints `4` (or the equivalent)
  followed by a newline to stdout. Nothing else. Exit 0.
- `echo "what's 2+2" | loom prompt agent.toml` works (stdin form).
- `loom prompt agent.toml --format=trace "check disk"` shows the
  coalesced trace with tool calls.
- `loom prompt agent.toml --format=jsonl "hi" | jq -c` works (one
  valid JSON per line).
- Multi-segment turns with tools produce only the final agent
  message in `text` mode.
- The system prompt is augmented for `text` mode; verified by
  test.
- Exit codes match the table.
- `npx tsc -p tsconfig.json --noEmit` returns 0 errors.
- `npm test` passes; new tests cover all three modes + exit codes.
- README's CLI reference section is updated to mention `--format`
  with a one-line description of each mode.

Good luck.
