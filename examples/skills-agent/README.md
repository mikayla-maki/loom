# skills-agent — Agent Skills as contributed tool groups

A tour of loom's skills model: skills are folders of instructions that may
also *declare tools and ship software*, all judged against the host
manifest's capability ceiling. Five skills, five tiers:

| Skill | Demonstrates |
|---|---|
| `release-notes/` | Pure instructions. No declarations → the authority-free group `{ read_skill: {} }`. Activation and bundled reads go through the `read_skill` tool — the skill holds no read grants, no paths, nothing. |
| `dns-lookup/` | Frontmatter `loom.tools` adding a **row** to the existing `bash` instance: `dig` gets network, everything else stays network-dark. Plain `dig args…` promotes to argv-exec (no shell) under its row; `dig … \| head` runs in the network-dark general row and fails — the attribution rule, live. |
| `json-wrangler/` | A `loom.toml` **sidecar** (wins over frontmatter — the "enhance a skill you didn't author" form) declaring a NEW renamed instance: `jq`, backed by the bash builtin, accepted by the instance-name `jq` ceiling entry. |
| `echo-notes/` | A skill **shipping its own MCP server** via `loom.providers`. Running contributed code requires naming the instance in `[capabilities]` — the `echo_note = "*"` line is the consent. Group-local provider handles dedup globally by value. |
| `web-downloader/` | Deliberately rejected: it wants `curl` + network and nothing accepts that. Boot is fail-soft, the skill vanishes from the model's catalog, and `loom audit` prints the paste-ready acceptance line. |

## Try it

Run from this directory (capability `paths` resolve against the cwd):

```sh
cd examples/skills-agent
ANTHROPIC_API_KEY=dummy loom audit agent.toml
```

The audit shows the four ACTIVE skills with the ceiling entries that
granted them, the skill-shipped MCP server under `providers:` (loom spawns
and introspects it), and web-downloader INACTIVE with its remediation.
Pasting that remediation row into `[capabilities]` is the entire consent
flow — re-audit and the skill activates.

To chat with it for real, replace the dummy key:

```sh
ANTHROPIC_API_KEY=... loom run agent.toml
```

Try: "what's in my skills catalog?", "what does example.com resolve to?",
"echo something through the notes tool", or "use jq to list the keys in
package.json". For the attribution rule live: ask it to run
`dig +short example.com` (works — promotes to the network row), then
`dig +short example.com | head -1` (fails — pipes run in the network-dark
general row).

## Things worth noticing

- **Skill reads carry provenance.** Activation isn't an anonymous
  `read_file` over some skills path — it's a `read_skill` call naming the
  skill, so transcripts and audit logs show *which* skill the model
  consulted. The tool is contributed by the skills layer itself
  (`read_skill = { provider = "session" }` in its own "skills session"
  group) and self-polices containment via realpath; trimmed skills are
  invisible through it.
- **Ambient read authority shrank.** The ceiling's
  `read_file = { paths = ["./"] }` is purely working-directory authority
  — no `./skills` entry needed, because skill activation requires no read
  grants at all. Mounting the root in `[session]` is the consent to the
  skills' *instructions*; any *authority* they want still has to clear
  `[capabilities]`.
- **One consent grammar.** Every acceptance in `agent.toml` — the `dig`
  bash row, the `jq` instance entry, the `echo_note = "*"` line — is just
  a `[capabilities]` row; `loom audit` shows exactly which row granted
  each declaration.
