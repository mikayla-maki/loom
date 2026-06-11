# @mcmaki/loom-capabilities

The capability layer of [Loom](https://github.com/mikayla-maki/loom), as a standalone library — the *format*, separated from the runtime:

- **The grant grammar**: `CapabilitySet` (single grants, wildcard, capability sets / row sets), parsed by the same code that parses `agent.toml`.
- **The tool-owned algebra**: the `GrantAlgebra` lattice contract (`containsGrant` as partial order, `mergeGrants` as least upper bound), the strict default semantics, and `checkGrantAlgebra` — a property-based conformance checker driven by `sampleGrant`.
- **Judging**: `ceilingFor`, `containsDeclaration`, `applyToolGroups`, `toolGroupQualifies` — verdicts carry paste-ready `[capabilities]` remediation lines.
- **Manifest fragments**: `parseManifestFragments` parses whatever sections a TOML file contains (a `[capabilities]`-only file is valid); `parseAgentManifest` is the validating wrapper demanding `[agent].name` + `[harness]`.
- **The Agent Skills compiler**: `loadSkill` / `compileToolGroup` / `parseFrontmatter` — SKILL.md `loom.tools` declarations and `loom.toml` sidecars, with `${SKILL_DIR}` substitution.

Everything here is pure or filesystem-read-only: no model calls, no process spawning, no runtime. Hosts embedding capability checking (e.g. [ca-pi](https://github.com/mikayla-maki/ca-pi)) depend on this package; the sandbox that enforces bash grants lives in `@mcmaki/loom-sandbox`; the full agent runtime is `@mcmaki/loom`.
