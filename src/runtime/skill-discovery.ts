/**
 * Builtin tool: `search_skills` — list skills addressable from providers,
 * the local registry, or the bundled builtins.
 *
 * Read-only: returns a JSON array of skill summaries. Adding a skill to
 * the running agent is a *client* concern (re-run with a manifest that
 * includes the new skill, or maintain a session-level allowlist), not a
 * runtime mutation. The dynamic-addition path used to live here as
 * `add_skill`; it was removed because expanding the agent's ceiling at
 * runtime entangled the tool runtime with permission machinery for a
 * use case that's better served outside the agent loop.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { unionCapabilities } from "../manifest/capabilities.js";
import { parseSkillManifest, parseToolManifest } from "../manifest/parser.js";
import { LocalRegistry } from "../registry/registry.js";
import type { Provider, Tool, ToolResult } from "../types/interfaces.js";
import type {
  SandboxCeiling,
  SkillManifest,
  ToolCapabilities,
} from "../types/manifest.js";
import type { JSONSchema } from "../types/schema.js";

import type { AgentState } from "./agent-state.js";

export interface SkillDiscoveryDeps {
  state: AgentState;
  providers: Provider[];
  registry?: LocalRegistry;
  builtinsDir: string;
}

interface SkillSummary {
  name: string;
  description: string;
  source: "registry" | "builtin" | "provider";
  location: string;
  tools: string[];
  capabilities: SandboxCeiling;
  fitsCeiling: boolean;
}

const SEARCH_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Optional substring filter on name + description.",
    },
  },
};

export class SearchSkillsTool implements Tool {
  public readonly name = "search_skills";
  public readonly description =
    "List skills available from the registry, builtins, or active providers. Read-only.";
  public readonly inputSchema = SEARCH_SCHEMA;

  constructor(private readonly deps: SkillDiscoveryDeps) {}

  async execute(input: unknown): Promise<ToolResult> {
    const q = (input as { query?: unknown } | undefined)?.query;
    const query = typeof q === "string" && q ? q.toLowerCase() : null;
    const summaries = await collectAvailableSkills(this.deps);
    const filtered = query
      ? summaries.filter(
          (s) =>
            s.name.toLowerCase().includes(query) ||
            s.description.toLowerCase().includes(query),
        )
      : summaries;
    return { content: JSON.stringify(filtered, null, 2) };
  }
}

// ─── discovery ─────────────────────────────────────────────────────────────

async function collectAvailableSkills(
  deps: SkillDiscoveryDeps,
): Promise<SkillSummary[]> {
  const out = new Map<string, Omit<SkillSummary, "fitsCeiling">>();

  for (const p of deps.providers) {
    const r = await Promise.resolve(p.list());
    for (const sk of r.skills ?? []) {
      if (out.has(sk)) continue;
      out.set(sk, {
        name: sk,
        description: "(provider-supplied skill)",
        source: "provider",
        location: "synthetic",
        tools: [],
        capabilities: {},
      });
    }
  }

  const reg = deps.registry ?? new LocalRegistry();
  await scanSkillDir(path.join(reg.root, "skills"), out, "registry");
  await scanSkillDir(path.join(deps.builtinsDir, "skills"), out, "builtin");

  const ceiling = deps.state.ceiling;
  return [...out.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({
      ...s,
      fitsCeiling: capabilityFits(s.capabilities, ceiling),
    }));
}

async function scanSkillDir(
  dir: string,
  out: Map<string, Omit<SkillSummary, "fitsCeiling">>,
  source: "registry" | "builtin",
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillDir = path.join(dir, entry.name);
    let skill: SkillManifest;
    try {
      skill = await parseSkillManifest(skillDir);
    } catch {
      continue;
    }
    if (!skill.name || out.has(skill.name)) continue;

    // Best-effort capability rollup: parse each declared tool. Failures
    // (missing tool, opaque builtin shorthand) just leave caps empty.
    const caps: ToolCapabilities[] = [];
    const toolNames: string[] = [];
    for (const ref of Object.values(skill.requires ?? {})) {
      // Inline tool refs are already in-hand: use directly.
      if (typeof ref !== "string") {
        if (ref.capabilities) caps.push(ref.capabilities);
        if (ref.name) toolNames.push(ref.name);
        continue;
      }
      const toolDir =
        skill.skillDir !== undefined
          ? listingToolDir(ref, skill.skillDir)
          : null;
      if (!toolDir) continue;
      try {
        const t = await parseToolManifest(toolDir);
        if (t.capabilities) caps.push(t.capabilities);
        if (t.name) toolNames.push(t.name);
      } catch {
        // skip
      }
    }
    out.set(skill.name, {
      name: skill.name,
      description: skill.description,
      source,
      location: skillDir,
      tools: toolNames,
      capabilities: unionCapabilities(caps),
    });
  }
}

function listingToolDir(ref: string, baseDir: string): string | null {
  if (ref === "builtin") return null; // need the requires-key (not in scope here)
  if (ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("/")) {
    return path.resolve(baseDir, ref);
  }
  return null; // provider/registry refs need richer resolution; skip at search time
}

function capabilityFits(req: SandboxCeiling, ceiling: SandboxCeiling): boolean {
  for (const axis of ["filesystem", "network", "secrets"] as const) {
    // Absent ceiling axis = unconstrained, so anything fits.
    if (ceiling[axis] === undefined) continue;
    const c = new Set(ceiling[axis] ?? []);
    for (const r of req[axis] ?? []) {
      if (!c.has(r)) return false;
    }
  }
  return true;
}
