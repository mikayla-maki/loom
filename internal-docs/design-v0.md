# Glass — A Manifest-Driven Agent Meta-Harness

A declarative runtime for composing agents. Built around four resources, four
interfaces, two faces, one external protocol, and one security principle.

## The shape, in one paragraph

An agent is an `agent.toml` declaring a harness extension, a session extension,
an identity, a sandbox capability ceiling, and a set of skills. Skills bring
tools transitively; tools bring secret declarations and capability declarations.
Glass resolves the manifest (loads extensions, walks the skill→tool dependency
graph, fetches secrets, validates capabilities, sets up `PATH` for tool
binaries), instantiates a `Session` and a `Harness`, and returns a
`RunningAgent` SDK handle. Clients drive the agent by calling `prompt(text)`
per turn and subscribing to `updates()` for live progress; each turn runs to
completion and returns a `StopReason`. During a turn, the `Harness` owns the
loop — it pulls the system prompt from the runtime (which Glass assembled),
calls the model, dispatches tool calls through a `Runtime` that exposes
session reads + tool execution + update emission, and decides parallelism and
termination. Tools are processes invoked with input on
stdin, output on stdout, and secrets on env vars; the model never sees
credentials. The Harness produces ACP-shaped `SessionUpdate` values; the
runtime fans them to the session log and to update subscribers. Subagent
spawning is a builtin tool that recursively runs another `agent.toml` and
returns its final output. The same SDK can be exposed over the wire as ACP —
any client (CLI, editor, Discord listener, parent agent) talks to any agent
the same way, in-process or out.

## The four resources

| Resource | What it is | Resolution | Trust |
|---|---|---|---|
| **Harness** | LLM-call shim + loop policy | bare-string name | runtime extension |
| **Session** | event log + lifecycle (may also expose memory skills) | bare-string name | runtime extension |
| **Skill** | capability bundle with knowledge + tool deps | path (later: registry ref) | dependency |
| **Tool** | sandboxed executable invoked by model | path (later: registry ref) | dependency |

Extensions run as the runtime (trusted). Dependencies are resolved into the
runtime (sandboxed at the tool layer).

## Manifests

### `agent.toml`

```toml
[agent]
name = "morning-checkin"
description = "DMs me a morning summary based on calendar + memory"
identity = "../identity/companion.md"   # path or `identity_inline = "..."`

[harness]
provider = "anthropic"
model = "claude-opus-4-7"

[session]
provider = "file"
path = "./session.jsonl"

[sandbox]
# Upper bound on what this agent can do. The runtime computes the union of
# capabilities required by all transitively-resolved tools and refuses to
# start if it doesn't fit inside this ceiling.
filesystem = ["./", "../identity"]
network = ["discord.com", "discordapp.com"]
secrets = ["discord_webhook_url"]

[skills]
discord-dm        = "../skills/discord-dm"
calendar-summary  = "../skills/calendar-summary"
memory            = "../skills/memory"
```

`[harness]` and `[session]` declare extensions by name plus their config.
`[skills]` declares dependencies by path. Tools don't appear — they come in
transitively through skills. `[agent].identity` holds the always-on
"who am I" content; the runtime inlines it into the system prompt every turn.
`[sandbox]` is the capability ceiling.

### `SKILL.md`

[agentskills.io](https://agentskills.io/specification) spec plus one added
field: `requires`.

```md
---
name: discord-dm
description: Send a Discord DM. Use when the agent needs to message the user.
requires:
  discord.send: ../../tools/discord-send
  secrets.get: builtin
---

# Discord DM

To send a message, call `discord.send` with `{content}`.
The recipient is configured at install time and stored as a secret.
```

`requires` maps the tool name the model will see to where the tool lives.
`builtin` resolves to Glass's own tools directory.

### `tool.toml`

```toml
[tool]
name = "discord.send"
description = "Send a message to the user via Discord webhook."

[tool.schema]
type = "object"
required = ["content"]
properties.content.type = "string"

[tool.invocation]
command = "discord-send"   # PATH-resolved, or shipped in ./bin/

[tool.secrets]
required = ["discord_webhook_url"]

[tool.capabilities]
network = ["discord.com", "discordapp.com"]
filesystem = []   # this tool touches no disk
```

Six sections. Name + description (model-facing). JSON Schema for input
validation. Command to exec. Declared secret names (resolved from the secrets
store, passed as env vars to the process; never visible to the model).
Declared capabilities (network egress, filesystem access). The runtime checks
these against the agent's `[sandbox]` ceiling at load time.

Tool directory layout:

```txt
discord-send/
├── tool.toml
└── bin/
    └── discord-send       # optional — only if the tool ships its own
```

### Builtin tools

Tools whose `bin/` lives in Glass's own directory. Structurally identical to
user-installed tools; just pre-installed.

```txt
glass/
├── bin/                    # auto-PATH'd
│   ├── bash
│   ├── secrets-get
│   └── spawn-subagent
└── tools/
    ├── bash/tool.toml
    ├── secrets.get/tool.toml
    └── spawn-subagent/tool.toml
```

`spawn-subagent` takes `{scope, prompt}`, resolves another `agent.toml` at the
given scope, runs it, returns its final output. Recursion is just a tool
call — and because the child boots into its *own* sandbox declaration,
permission inheritance is explicit: a parent cannot grant capabilities to a
child it doesn't itself have.

## Capabilities and sandboxing

**Every scope is sandboxed by default. Tools are the only mechanism that
grants capability. A manifest's `[sandbox]` block is the upper bound; the
runtime verifies that the transitive set of tool-required capabilities fits
inside it before running.**

This is the architectural-security claim. Three consequences:

1. **An agent boots with zero ambient capability.** No filesystem, no network,
   no secrets. The `Tool` interface is the *only* way to touch anything
   outside the model loop.
2. **Capabilities are statically computable.** Walk an `agent.toml`, follow
   skills to tools, union their declared capabilities. That set is the agent's
   total capability surface. You can show it to the user before running.
3. **Subagents inherit nothing implicitly.** `spawn-subagent` runs another
   manifest with its own `[sandbox]` ceiling. The child can have *more*
   capability than the parent (if its manifest declares it and its tools have
   it), the same, or less. There is no parent → child grant.

v0 ships with `[sandbox]` enforced at *declaration time only* — the runtime
checks that tool capabilities ⊆ manifest capabilities and refuses to start
otherwise. Actual OS-level isolation (process boundaries, network policy,
filesystem jails) lands when a tool needs it. The architecture has the slot;
v0 doesn't fill it.

The principle that earns its keep here is the one from old-Glass:

> If something shouldn't be possible, make it structurally impossible.

this is **compositional**: the trust class of an agent *falls out* of the skills 
it wires in.

## System prompt and identity

**Glass owns system-prompt assembly.** Every turn, the runtime composes a
single system prompt string from three sources and exposes it to the Harness
via `runtime.systemPrompt()`. The Harness consumes the assembled prompt; it
does not build one.

The three sources:

1. **Runtime-owned (structural).** "Here are the skills available and how to
   invoke them." Glass knows the resolved skill/tool graph.
2. **Manifest-owned (semantic).** The `[agent].identity` content. Static-ish;
   the same across all reflections of one self.
3. **Per-turn (dynamic).** Current date, anything else Glass injects per turn.

This keeps prompt format consistent across providers and means swapping a
Harness extension does not change what the model sees in the system slot. A
Harness extension that *needs* to override (provider-specific formatting,
prompt-caching tricks) can read the components separately via
`runtime.identity()` and `runtime.listSkills()` and assemble its own — that's
an opt-out, not the default.

Identity is on `[agent]`, not `[harness]`, because every Harness extension
needs one and the value is provider-agnostic.

### Sessions can contribute skills

A session implementation MAY contribute skills to the agent. These are
merged with manifest-declared skills at boot. Sessions whose memory
architecture requires agent participation — compaction prompts, memory recall
tools, RLM-style block management — ship those interactions as session-owned
skills. The agent does not distinguish session-contributed skills from
manifest-declared skills.

The `Session` interface reserves the slot; v0 sessions can return `[]`. When
a session like RLM lands, it ships a `memory-recall` / `memory-update` /
`memory-compact` skill bundle and the agent picks them up automatically.

## The four core interfaces

```ts
// Session: durable log; may also contribute skills (memory architecture).
interface Session {
  append(update: SessionUpdate): Promise<void>;
  getEvents(from?: number, to?: number): Promise<SessionUpdate[]>;

  // Optional: skills this session contributes to the agent (memory APIs etc.)
  skills?(): Skill[];

  // Optional: for session providers that manage many sessions
  list?(): Promise<SessionDescriptor[]>;
  resume?(id: string): Promise<Session>;
}

// Runtime: services Glass provides to the Harness during a turn.
interface Runtime {
  getEvents(from?: number, to?: number): Promise<SessionUpdate[]>;
  update(update: SessionUpdate): Promise<void>;  // appends to session + emits to client

  systemPrompt(): string;        // assembled by Glass; the Harness's default

  // Components — for Harness extensions that need to override systemPrompt()
  identity(): string;            // resolved [agent].identity content
  listSkills(): SkillDescriptor[];

  listTools(): ToolDescriptor[];
  executeTool(call: ToolCall): Promise<ToolResult>;
}

// Harness: owns the loop for a single turn.
interface Harness {
  run(runtime: Runtime): Promise<StopReason>;
}

// Tool: capability invoked by the model.
interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  execute(input: unknown, secrets: Record<string, string>): Promise<string>;
}
```

In one sentence each:

- **Session** stores updates and may contribute memory-management skills.
  Internal storage format is its own business; the interface is ACP-shaped.
- **Runtime** is what the Harness calls to do anything outside its own
  model-call logic.
- **Harness** runs a single turn — pulls the system prompt from the runtime,
  calls the model, dispatches tool calls, decides parallelism and
  termination.
- **Tool** is an invokable capability with a schema, declared secrets, and
  declared capabilities.

The Harness produces ACP-shaped `SessionUpdate` values because they're a good
vocabulary and reusing them eliminates a translation layer. Sessions accept
them at the interface; how they're stored internally is up to the
implementation.

## The two faces (SDK + Runtime)

Glass is both an SDK (for clients embedding agents) and a runtime (for
harnesses to call into during a turn). Different consumers, different
surfaces.

### SDK face: `RunningAgent`

What clients use to drive an agent across turns.

```ts
interface RunningAgent {
  prompt(text: string): Promise<StopReason>;          // run one turn
  cancel(): Promise<void>;                            // interrupt current turn
  updates(): AsyncIterable<SessionUpdate>;            // subscribe to live updates
  session: Session;                                   // direct access for inspection
}

async function runAgent(manifestPath: string): Promise<RunningAgent> {
  // Resolves manifest, loads extensions, walks skills→tools→secrets,
  // validates capabilities, sets up PATH, instantiates session/harness,
  // returns the handle. Does NOT run a turn yet — the client triggers
  // turns via prompt().
}
```

### Runtime face: `Runtime`

What harnesses call during a turn (shown above).

The two faces talk to the same underlying state — the same session, same tool
table, same in-flight turn — but expose different operations to different
consumers. Clients drive turns; harnesses run them.

## The external protocol: ACP

The same SDK face, exposed over the wire. Anyone driving an agent — a CLI,
a Discord listener, Zed, a parent agent — can speak ACP instead of using the
in-process SDK.

- `session/prompt` (client → Glass): drive the agent with a user message.
  Maps to `RunningAgent.prompt()`.
- `session/update` (Glass → client): streaming notifications as the turn
  progresses. Maps to `RunningAgent.updates()`.
- `StopReason` (response): turn ended; here's why. Maps to
  `RunningAgent.prompt()`'s return.
- `session/cancel` (client → Glass): interrupt the running turn. Maps to
  `RunningAgent.cancel()`.

ACP is the wire version of the SDK. Subagent spawning composes naturally
because the parent Glass becomes an ACP client of the child Glass — same
protocol both ways.

## How a conversation flows

The Harness never waits for user input. Each turn is bounded — runs to
completion and returns. The client is responsible for driving the next turn.

### CLI loop

```ts
const agent = await runAgent("./agent.toml");

// stream updates to stdout in the background
(async () => {
  for await (const update of agent.updates()) {
    cli.render(update);
  }
})();

while (true) {
  const userInput = await readline();
  if (!userInput) break;
  await agent.prompt(userInput);  // runs one turn; updates streamed during
}
```

### Discord-driven

```ts
const agent = await runAgent("./agent.toml");

discord.on("message", async (msg) => {
  if (msg.author.id !== ownerId) return;
  await agent.prompt(msg.content);
  // The agent's reply went out via the discord.send tool during the turn.
});
```

### Subagent (parent calling child)

```ts
// Inside the spawn-subagent builtin tool:
const child = await runAgent(childManifestPath);
await child.prompt(promptFromParent);
const finalMessage = await extractFinalMessage(child.session);
return finalMessage;  // returned to the parent's tool call
```

Same SDK, three different drivers. The agent doesn't know or care.

## Pseudocode: a harness implementation

```ts
class AnthropicHarness implements Harness {
  constructor(private model: string, private apiKey: string) {}

  async run(runtime: Runtime): Promise<StopReason> {
    while (true) {
      const events = await runtime.getEvents();
      const messages = this.eventsToMessages(events);

      const response = await this.callAnthropic(
        runtime.systemPrompt(),   // assembled by Glass
        messages,
        runtime.listTools(),
      );

      await runtime.update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: response.text }
      });

      if (response.toolCalls.length === 0) return "end_turn";

      // Parallel tool dispatch — sequential is just a different awaiting pattern
      await Promise.all(
        response.toolCalls.map(async (call) => {
          await runtime.update({
            sessionUpdate: "tool_call",
            toolCallId: call.id,
            title: call.name,
            status: "pending"
          });
          const result = await runtime.executeTool(call);
          await runtime.update({
            sessionUpdate: "tool_call_update",
            toolCallId: call.id,
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: result.content } }]
          });
        })
      );
    }
  }

  private eventsToMessages(events: SessionUpdate[]) { /* ... */ }
  private async callAnthropic(...) { /* provider-specific */ }
}
```

## Pseudocode: a session implementation

```ts
class FileSession implements Session {
  constructor(private path: string) {}

  async append(update: SessionUpdate): Promise<void> {
    await fs.appendFile(this.path, JSON.stringify(update) + "\n");
  }

  async getEvents(from = 0, to?: number): Promise<SessionUpdate[]> {
    const lines = (await fs.readFile(this.path, "utf8")).split("\n").filter(Boolean);
    return lines.slice(from, to).map(line => JSON.parse(line));
  }
}
```

A SQLite session is structurally similar with rows. A remote session is
structurally similar with HTTP. An RLM session adds a `skills()` method that
returns a memory-management skill bundle. Each can store updates however it
wants; the interface is ACP-shaped.

## Pseudocode: a tool implementation (shipped script)

`discord-send/bin/discord-send`:

```sh
#!/usr/bin/env node
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const webhook = process.env.DISCORD_WEBHOOK_URL;
fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: input.content })
}).then(r => {
  if (!r.ok) { console.error(`Discord error: ${r.status}`); process.exit(1); }
  console.log(JSON.stringify({ ok: true }));
});
```

Stdin: JSON input. Stdout: result string. Stderr (on nonzero exit): error
string. Secrets: env vars. Model never sees the webhook URL.

## Pseudocode: Glass itself

```ts
async function runAgent(manifestPath: string): Promise<RunningAgent> {
  // 1. Resolve manifest
  const manifest = parseToml(await fs.readFile(manifestPath, "utf8"));

  // 2. Load extensions by name
  const harnessExt = loadHarnessExtension(manifest.harness.provider);
  const sessionExt = loadSessionExtension(manifest.session.provider);

  // 3. Resolve skills → transitive tools → secrets + capabilities
  const skills = await Promise.all(
    Object.entries(manifest.skills).map(([name, path]) => loadSkill(name, path))
  );
  const toolPaths = collectToolDependencies(skills);  // walks `requires`
  const tools = await Promise.all(toolPaths.map(loadTool));

  // 4. Validate capabilities against the manifest's [sandbox] ceiling
  const required = unionCapabilities(tools);
  const ceiling = manifest.sandbox ?? {};
  assertSubset(required, ceiling);  // refuses to start if a tool wants more

  // 5. Resolve secrets (prompts user if missing)
  const secrets = await resolveSecrets(tools);

  // 6. Add tool bin/ dirs to PATH
  for (const tool of tools) {
    if (tool.shipsBinary) addToPath(tool.binDir);
  }

  // 7. Instantiate session and harness
  const session = sessionExt.create(manifest.session);
  const harness = harnessExt.create(manifest.harness);

  // 8. Merge session-contributed skills with manifest-declared skills
  const allSkills = [...skills, ...(session.skills?.() ?? [])];

  const toolTable = new ToolTable(tools, secrets);
  const updateSink = new UpdateSink();  // fan-out to subscribers

  // 9. Resolve identity
  const identity = await loadIdentity(manifest.agent.identity);

  // 10. Return the SDK handle — does NOT run a turn yet
  return new RunningAgentImpl({
    async prompt(text: string): Promise<StopReason> {
      await session.append({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text }
      });
      const runtime = new RuntimeImpl(
        session, toolTable, allSkills, identity, updateSink
      );
      return await harness.run(runtime);
    },
    async cancel() { /* signal current turn to stop */ },
    updates() { return updateSink.subscribe(); },
    session,
  });
}
```

The runtime's `update()` writes to the session and forwards to all subscribers
(the `updates()` iterable, plus any attached ACP client). Same call, multiple
consumers.

## What's not in v0 (and that's correct)

- **No registry.** Local paths only; bare-string extension names resolve to
  builtins.
- **No OS-level sandbox enforcement.** `[sandbox]` capability *declarations*
  are validated at load time (tool-required ⊆ manifest-ceiling). Actual
  process isolation, network jails, and filesystem confinement land when a
  tool needs them. The architecture has the slot.
- **No replay-on-wake.** Add later when needed; the session log makes it
  possible.
- **No context compaction in the core.** A session implementation can do it
  internally (and contribute the agent-facing skills it needs). A future
  helper may standardize.
- **No mid-turn user input prompts.** Conversation is turn-based; clarifying
  questions end the turn and resume on the next prompt. ACP
  `session/request_permission` is a v1+ option for richer flows.
- **No streaming append protocol distinct from update emission.** The harness
  emits `agent_message_chunk` updates as tokens arrive (or as complete
  messages); the session decides how to coalesce.
- **No display rendering inside the session.** ACP `session/update` is the
  display protocol; consumers render however they want.
- **No automatic session-skill installation.** If a session needs the agent
  to manage memory, the user adds the corresponding skills to `[skills]`
  explicitly (or uses a CLI helper like `glass install-template rlm-agent`).
  Nothing happens behind the manifest's back.

## References and influences

- **Anthropic — *Scaling Managed Agents: Decoupling the brain from the hands*.**
  <https://www.anthropic.com/engineering/managed-agents>
  The component model (Session / Orchestration / Harness / Sandbox /
  Resources / Tools) is the conceptual ancestor. Glass collapses it to four
  resources by folding orchestration into the SDK driver and merging
  Sandbox + Resources into capability-declaring tools.
- **Agent Skills specification.**
  <https://agentskills.io/specification>
  SKILL.md as-is. Glass adds one field (`requires`) to give skills a
  transitive tool-dependency story.
- **Agent Client Protocol (ACP).**
  <https://agentclientprotocol.com/get-started/introduction> /
  <https://agentclientprotocol.com/protocol/prompt-turn>
  The SDK face and the wire protocol are the same shape because the wire
  protocol is good. `SessionUpdate` is reused verbatim. Subagent spawning is
  modeled as the parent Glass becoming an ACP client of the child.
- **Pi.** <https://pi.dev>
  Pi's defaults — manifest-driven agents, declarative skill loading,
  process-per-tool — closely prefigure this design. Glass generalizes the
  shape and exposes the SDK / Runtime split explicitly.
- **Recurrent / RLM-style memory architectures.**
  <https://arxiv.org/html/2512.24601v2>
  Motivates the session-can-contribute-skills carve-out. A session whose
  memory architecture requires agent participation ships those interactions
  as part of itself rather than relying on out-of-band wiring.

---

Four manifests, four interfaces, two faces (SDK + Runtime), one external
protocol (ACP), one security principle (every scope sandboxed; tools punch
out). A small Glass core that wires it all together. Hand it off and go.
