/**
 * `${VAR}` / `${VAR:-default}` substitution on parsed manifest values.
 *
 * Walks an arbitrary JSON-shaped value (strings, numbers, booleans,
 * arrays, plain objects) and rewrites every string that contains a
 * `${...}` reference. Used by `parseAgentManifest` so manifest files
 * can parameterise paths, hostnames, model ids, metadata tags, etc.
 * from the environment without hard-coding them in the TOML.
 *
 * Why this lives in Loom (vs. expecting clients to substitute):
 *
 *   - The manifest is Loom's vocabulary; substitution is a
 *     manifest-level transformation. Every client would otherwise
 *     reimplement the same scan.
 *   - It composes with the existing parser → resolver pipeline:
 *     substitution happens once at parse, and every downstream
 *     consumer (validation, resolver, audit, runtime) sees ready-
 *     to-use values.
 *
 * What this is NOT:
 *
 *   - A secret store. Don't write `${ANTHROPIC_API_KEY}` here; baked
 *     into the manifest object, the key shows up in any place the
 *     manifest is logged / serialised / printed. Use the secret
 *     store (`SecretsStore` chain) for credentials — it carries
 *     per-tool filtering and no-log semantics.
 *   - Shell-style expansion. No `$VAR` (no braces), no `$(cmd)`,
 *     no `$((arith))`. Explicit braces only; the rest of the
 *     interesting `$` syntax in shell scripts is out of scope.
 *
 * Syntax accepted:
 *
 *   - `${NAME}`                  required; throws if `NAME` unset
 *   - `${NAME:-fallback text}`   optional; substitutes `fallback text`
 *                                when `NAME` is unset
 *
 * Variable names follow the conventional POSIX shape: start with a
 * letter or underscore, then letters / digits / underscores.
 */

import { ManifestError } from "../errors.js";

/**
 * `${NAME}` or `${NAME:-default}` reference. Captures:
 *   - group 1: the variable name
 *   - group 2 (optional): the default value, when `:-default` is present
 */
const REFERENCE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export interface EnvSubstitutionOptions {
  /**
   * Source of environment values. Defaults to `process.env`. Tests
   * pass a fixed object so behaviour is deterministic.
   */
  env?: Record<string, string | undefined>;
  /**
   * Optional context string used in error messages, e.g. the path
   * of the file being parsed. The substitution itself is identical;
   * this just makes "undefined env var in your manifest" errors
   * point at the right file.
   */
  context?: string;
}

/**
 * Recursively substitute `${VAR}` and `${VAR:-default}` references
 * in `value`. Returns a structurally-identical value with every
 * matching string rewritten; non-string scalars (numbers, booleans,
 * null) and keys of objects pass through untouched.
 *
 * Throws `ManifestError` when a required reference (`${NAME}`
 * without a default) names a variable that isn't in `env`.
 */
export function substituteEnv(
  value: unknown,
  opts: EnvSubstitutionOptions = {},
): unknown {
  const env = opts.env ?? process.env;
  return walk(value, env, opts.context);
}

function walk(
  value: unknown,
  env: Record<string, string | undefined>,
  context: string | undefined,
): unknown {
  if (typeof value === "string") {
    return substituteString(value, env, context);
  }
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, env, context));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Keys are intentionally NOT substituted: they're identifiers,
      // not configuration values. If a user genuinely needs a dynamic
      // key they can construct the manifest programmatically and
      // route through `runAgent(manifest)`.
      out[k] = walk(v, env, context);
    }
    return out;
  }
  return value;
}

function substituteString(
  s: string,
  env: Record<string, string | undefined>,
  context: string | undefined,
): string {
  // Fast path: most strings have no `${`. Skip the regex entirely.
  if (!s.includes("${")) return s;
  return s.replace(REFERENCE_PATTERN, (_match, name: string, defaultValue) => {
    const v = env[name];
    if (v !== undefined) return v;
    if (defaultValue !== undefined) return defaultValue;
    const where = context ? ` (in ${context})` : "";
    throw new ManifestError(
      `Manifest references undefined env var '${name}'${where}. ` +
        `Set the env var, or use \${${name}:-default} to provide a fallback ` +
        `inline.`,
    );
  });
}
