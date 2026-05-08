/**
 * Skill path conventions.
 *
 * Loom presents skills to the model as files: the system-prompt
 * catalog renders each skill's path next to its description, and the
 * model fetches the full SKILL.md with `read_file`. On-disk skills
 * use their real fs path; inline skills (declared in agent.toml as
 * `{ description, body, requires }`) get a synthetic URI under the
 * `loom-skills:` scheme.
 *
 *   loom-skills:<name>/SKILL.md
 *
 * `read_file` checks for that prefix before the fs path resolution
 * step and serves the body from a per-agent in-memory map. The
 * scheme is intentionally not a real fs path so collisions with disk
 * paths are impossible.
 *
 * Bundled resources are not part of the inline form (inline skills
 * are body-only); the model never needs to read past `SKILL.md` for
 * a virtual skill. On-disk skills can have any number of bundled
 * files in their `skillDir`, accessed via `read_file` against the
 * real path \u2014 loom auto-allowlists the dir at boot.
 */

import * as path from "node:path";

import type { SkillManifest } from "../types/manifest.js";

export const VIRTUAL_SKILL_SCHEME = "loom-skills:";

export function virtualSkillPath(skillName: string): string {
  return `${VIRTUAL_SKILL_SCHEME}${skillName}/SKILL.md`;
}

export function isVirtualSkillPath(p: string): boolean {
  return p.startsWith(VIRTUAL_SKILL_SCHEME);
}

/**
 * Compute the path the model uses to read a skill's SKILL.md. For
 * skills loaded from disk (`skillDir` set), that's the real fs path
 * to SKILL.md. For inline skills (no `skillDir`), it's the synthetic
 * `loom-skills:<name>/SKILL.md` URI.
 */
export function pathForSkill(skill: SkillManifest): string {
  if (skill.skillDir) {
    return path.join(skill.skillDir, "SKILL.md");
  }
  return virtualSkillPath(skill.name ?? "");
}

/**
 * Synthesize the bytes the model sees when it reads a virtual
 * skill's SKILL.md. We re-emit the YAML frontmatter (`name`,
 * `description`) so the shape matches an on-disk SKILL.md and the
 * model handles both uniformly.
 */
export function renderVirtualSkillFile(skill: SkillManifest): string {
  const fm: string[] = ["---"];
  if (skill.name) fm.push(`name: ${skill.name}`);
  if (skill.description) {
    // Description may contain colons; quote it to keep the YAML valid.
    fm.push(`description: ${JSON.stringify(skill.description)}`);
  }
  fm.push("---");
  const body = (skill.body ?? "").trim();
  return `${fm.join("\n")}\n\n${body}\n`;
}
