# SDK agent — building an agent imperatively

A Loom agent built directly in TypeScript, showing the **heterogeneous
session-array** shape: mix pre-built `Session` instances with named
layers in the same list, and the runtime resolves the named ones for
you.

The headline move:

```ts
const compactor = new CompactingSession({
  threshold: 60,
  compactor: modelCompactor(),
  onCompact: ({ before, after }) =>
    console.log(`[compacted] ${before} → ${after}`),
});

const manifest: AgentManifest = {
  // ...
  providers: { notes: { path: "../notes-provider" } },
  harness,
  session: [
    compactor,        // ← a pre-built Session instance, used verbatim
    "notes",          // ← string shorthand; resolved via [providers].notes
    "in-memory",      // ← built-in
  ],
  // ...
};
```

Why this matters: it lets you hand-build only the layer you want to
*control* (here, the compactor, so we can call `compactor.compactNow()`
from a `/compact` slash command), while leaving everything else to the
runtime's normal resolution. With the TOML form, every layer is owned
by the runtime — there's no handle to reach into.

This example shares the [`../notes-provider/`](../notes-provider/)
package with [`../full-agent/`](../full-agent/); the two agents
present the same notes-taking surface to the user. The difference is
purely about *who owns the compactor instance*.

## Layout

```
sdk-agent/
├── README.md
└── agent.ts            # builds the agent in TypeScript; refs ../notes-provider
```

## Run it

From the repo root (`loom/`):

```sh
# Build the notes provider (Loom imports its compiled output at runtime).
(cd examples/notes-provider && npm run build)

# Run it. tsx executes the TS directly — no separate build step for agent.ts.
ANTHROPIC_API_KEY=... npx tsx examples/sdk-agent/agent.ts
ANTHROPIC_API_KEY=... npx tsx examples/sdk-agent/agent.ts "please remember that I prefer dark mode"
```

The first form drops you into an interactive REPL with these
commands:

| Command | What it does |
|---|---|
| `/tokens`  | Read `compactor.tokensInContext` and `compactor.contextWindow` straight off the session instance. |
| `/compact` | Call `compactor.compactNow(harness)` immediately, regardless of the per-turn threshold. Prints `{ before, after }`. |
| `/help`    | List commands. |
| `/quit`    | Exit. |

When auto-compaction trips during a turn (event count ≥ 60), the
session's `onCompact` callback prints a one-line summary too.

## What it shows

| Construct | Demonstrates |
|---|---|
| `new AnthropicHarness(...)` | A harness held as an instance, not a `{ provider: "anthropic", ... }` spec. The same reference is handed to `runAgent` AND to `modelCompactor()`, so the summary pass runs through the same model. |
| `new CompactingSession({ compactor: modelCompactor(), onCompact, ... })` | A session layer constructed with options that don't have a TOML equivalent — a custom `Compactor` callback and an `onCompact` diagnostic hook. |
| `session: [compactor, "notes", "in-memory"]` | The heterogeneous-array form. The runtime resolves `"notes"` via `[providers].notes` (the local handle pointing at `../notes-provider`), resolves `"in-memory"` via the built-in registry, and chains all three layers outer-to-inner. |
| `handleSlashCommand(...)` | The payoff. `compactor.compactNow(harness)` and `compactor.tokensInContext` reach into the live session instance. With a TOML-driven agent there would be nothing to reach into. |

## How `manifest.session` resolves

`manifest.session` accepts four shapes:

| Shape | Effect |
|---|---|
| **`undefined`** | Runtime uses the default chain `skills → compacting → in-memory`. |
| **`SessionSpec`** (singleton) | Trivial one-layer session. TOML form: `[session]` with a `provider` field. |
| **Heterogeneous array** `SessionLayerEntry[]` | Each entry is a **string** (shorthand for `{ provider: str }`), a **`SessionSpec`** (`{ provider, ...config }`), or a **pre-built `Session` instance**. The runtime resolves the named entries, threads everything through `ChainedSession`. |
| **Pre-built `Session` instance** (singleton) | Bypasses manifest resolution entirely. Useful when you've already hand-built the whole chain. |

The string and `SessionSpec` entries mirror the TOML layered shape
exactly (`[[session.layers]]` blocks or `layers = ["a", "b"]` inline).
What the SDK adds is the ability to drop a pre-built instance in at
any position.

## How this differs from `full-agent/`

Functionally these two agents are equivalent — same harness, same
three-layer session, same tool set, same notes-provider. The
difference is purely about which side of the line the compactor
sits on:

- **`full-agent/`** declares `[[session.layers]] provider =
  "compacting"`. The runtime constructs the instance; nobody else
  has a reference to it. Auto-compaction works, but `/compact` as a
  slash command isn't possible because the CLI's REPL doesn't know
  which `Session` to call `compactNow()` on.
- **`sdk-agent/`** constructs the `CompactingSession` itself and
  passes the instance into the chain. The slash commands close
  over that reference.

Reach for the SDK shape when you need to drive a specific layer
imperatively. Use the TOML shape for everything else — it's shorter
and easier to audit.

## See also

- [`../full-agent/agent.toml`](../full-agent/agent.toml) —
  the declarative agent, for comparison.
- [`../notes-provider/`](../notes-provider/) — the provider this
  example depends on.
- The root [`README.md`](../../README.md) section **"Using Loom as
  a library"** for the broader SDK surface.
- [`../../src/builtins/session/compacting.ts`](../../src/builtins/session/compacting.ts)
  — the `CompactingSession` class with full option docs.
