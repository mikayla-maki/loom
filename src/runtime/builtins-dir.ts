/**
 * Locate the bundled `builtins/` directory at runtime.
 *
 * The directory ships at the repo root; from a compiled module we walk up
 * a few levels looking for it. Used by both the resolver (to load builtin
 * skills/tools) and the SDK (to give the in-process discovery tools the
 * same path).
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function findBuiltinsDir(fromUrl: string): string {
  const here = fileURLToPath(fromUrl);
  let dir = path.dirname(here);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "builtins");
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return path.join(path.dirname(path.dirname(here)), "builtins");
}
