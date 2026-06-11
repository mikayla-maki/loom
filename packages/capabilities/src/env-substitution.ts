import { ManifestError } from "./errors.js";

const REFERENCE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export interface EnvSubstitutionOptions {
  env?: Record<string, string | undefined>;
  context?: string;
}

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
