/**
 * Local registry — bare-name resolution against ~/.loom/{skills,tools,agents}.
 *
 * v1 layout (from the design doc):
 *   ~/.loom/
 *   ├── extensions/
 *   ├── skills/
 *   ├── tools/
 *   └── agents/
 *
 * Manifests in any of these directories are addressable by bare name from
 * any agent.toml. `loom install <path>` is just a copy/symlink helper.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

/** Bare-name lookup hook: kind + name → path on disk, or null. */
export type RegistryLookup = (
  kind: "skill" | "tool" | "agent",
  name: string,
) => string | null | Promise<string | null>;

export interface RegistryOptions {
  /** Override the registry root. Defaults to $LOOM_HOME or ~/.loom. */
  root?: string;
}

export class LocalRegistry {
  public readonly root: string;
  constructor(opts: RegistryOptions = {}) {
    this.root =
      opts.root ?? process.env.LOOM_HOME ?? path.join(os.homedir(), ".loom");
  }

  lookup: RegistryLookup = async (kind, name) => {
    // Strip optional "@version" — v1 string-equality only.
    const at = name.indexOf("@");
    const bare = at < 0 ? name : name.slice(0, at);
    const dir = path.join(this.root, kindDir(kind), bare);
    if (await isDir(dir)) {
      // For agents: return the agent.toml path; for skills/tools: the directory.
      if (kind === "agent") {
        const manifest = path.join(dir, "agent.toml");
        if (await fileExists(manifest)) return manifest;
        return null;
      }
      return dir;
    }
    return null;
  };

  /** Install (copy or symlink) a path into the registry. */
  async install(
    kind: "skill" | "tool" | "agent",
    sourcePath: string,
    options: { name?: string; symlink?: boolean } = {},
  ): Promise<string> {
    const src = path.resolve(sourcePath);
    const stat = await fs.stat(src);
    if (!stat.isDirectory())
      throw new Error(`Cannot install non-directory: ${src}`);
    const inferred =
      options.name ?? (await inferName(kind, src)) ?? path.basename(src);
    const dest = path.join(this.root, kindDir(kind), inferred);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.unlink(dest);
    } catch {
      // ignore
    }
    if (options.symlink) {
      await fs.symlink(src, dest, "dir");
    } else {
      await copyDir(src, dest);
    }
    return dest;
  }
}

function kindDir(kind: "skill" | "tool" | "agent"): string {
  return kind === "skill" ? "skills" : kind === "tool" ? "tools" : "agents";
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function inferName(
  kind: "skill" | "tool" | "agent",
  src: string,
): Promise<string | null> {
  try {
    if (kind === "tool") {
      const text = await fs.readFile(path.join(src, "tool.toml"), "utf8");
      const m = /\bname\s*=\s*"([^"]+)"/.exec(text);
      return m && m[1] ? m[1] : null;
    }
    if (kind === "skill") {
      const text = await fs.readFile(path.join(src, "SKILL.md"), "utf8");
      const m = /^name:\s*(\S+)/m.exec(text);
      return m && m[1] ? m[1] : null;
    }
    if (kind === "agent") {
      const text = await fs.readFile(path.join(src, "agent.toml"), "utf8");
      const m = /\[agent\][^[]*?\bname\s*=\s*"([^"]+)"/s.exec(text);
      return m && m[1] ? m[1] : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      await copyDir(s, d);
    } else if (e.isSymbolicLink()) {
      const target = await fs.readlink(s);
      await fs.symlink(target, d);
    } else {
      await fs.copyFile(s, d);
      const stat = await fs.stat(s);
      await fs.chmod(d, stat.mode);
    }
  }
}
