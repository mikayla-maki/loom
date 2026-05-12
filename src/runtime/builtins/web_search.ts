/**
 * `web_search` — query the Brave LLM Context API.
 *
 * Calls Brave's `/res/v1/llm/context` endpoint, which returns
 * pre-extracted, snippet-formatted search results designed for LLM
 * consumption (no scraping, no token-budget surprises). See
 * https://api-dashboard.search.brave.com/documentation/services/llm-context
 *
 * Secrets:
 *   required: BRAVE_SEARCH_API_KEY (the secret name is overridable
 *             via the `secret_name` config — useful when you keep the
 *             key under a different env name).
 *
 * Capabilities: none. The tool only ever talks to one host
 * (`api.search.brave.com`), so manifest capability grants don't have
 * a useful surface here. Configuration goes through `[tools.web_search]`.
 *
 * Per-tool config (all optional, all map to the Brave API params):
 *   count                  → count                            (1–50)
 *   freshness              → freshness                        (pd | pw | pm | py | YYYY-MM-DDtoYYYY-MM-DD)
 *   country                → country                          (2-char code)
 *   search_lang            → search_lang
 *   max_urls               → maximum_number_of_urls           (1–50)
 *   max_tokens             → maximum_number_of_tokens         (1024–32768)
 *   max_snippets           → maximum_number_of_snippets       (1–100)
 *   max_tokens_per_url     → maximum_number_of_tokens_per_url (512–8192)
 *   max_snippets_per_url   → maximum_number_of_snippets_per_url (1–100)
 *   threshold_mode         → context_threshold_mode           (strict | balanced | lenient | disabled)
 *   enable_local           → enable_local                     (true | false)
 *   goggles                → goggles                          (URL or inline definition)
 *   endpoint               → override the API endpoint (handy for tests)
 *   secret_name            → name of the secret to read the API key from
 *                            (default: "BRAVE_SEARCH_API_KEY")
 *
 * Input (model-facing):
 *   query     (required) — the search query
 *   freshness (optional) — overrides the configured default for one call
 *   count     (optional) — overrides the configured default for one call
 */

import type {
  Tool,
  ToolConfig,
  ToolContext,
  ToolDisplay,
  ToolResult,
  SecretNeeds,
} from "../../types/interfaces.js";
import type { CapabilitySet } from "../../types/manifest.js";
import type { JSONSchema } from "../../types/schema.js";

const DEFAULT_ENDPOINT = "https://api.search.brave.com/res/v1/llm/context";
const DEFAULT_SECRET_NAME = "BRAVE_SEARCH_API_KEY";

const FRESHNESS_PATTERN =
  "^(pd|pw|pm|py|[0-9]{4}-[0-9]{2}-[0-9]{2}to[0-9]{4}-[0-9]{2}-[0-9]{2})$";

const THRESHOLD_MODES = [
  "strict",
  "balanced",
  "lenient",
  "disabled",
] as const;
type ThresholdMode = (typeof THRESHOLD_MODES)[number];

const SCHEMA: JSONSchema = {
  type: "object",
  required: ["query"],
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 400,
      description:
        "The search query (max 400 chars, ~50 words). Use natural language; the API ranks for LLM grounding rather than keyword match.",
    },
    freshness: {
      type: "string",
      pattern: FRESHNESS_PATTERN,
      description:
        "Recency filter: pd (24h), pw (7d), pm (31d), py (365d), or YYYY-MM-DDtoYYYY-MM-DD. Overrides the configured default.",
    },
    count: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description:
        "How many results to consider (1-50). Overrides the configured default.",
    },
  },
};

interface WebSearchInput {
  query: string;
  freshness?: string;
  count?: number;
}

interface WebSearchConfig {
  endpoint?: string;
  secret_name?: string;
  count?: number;
  freshness?: string;
  country?: string;
  search_lang?: string;
  max_urls?: number;
  max_tokens?: number;
  max_snippets?: number;
  max_tokens_per_url?: number;
  max_snippets_per_url?: number;
  threshold_mode?: ThresholdMode;
  enable_local?: boolean;
  goggles?: string | string[];
}

interface BraveSnippetGroup {
  url?: string;
  title?: string;
  snippets?: unknown[];
}

interface BravePoi {
  url?: string;
  name?: string;
  title?: string;
  snippets?: unknown[];
}

interface BraveMap {
  url?: string;
  name?: string;
  title?: string;
  snippets?: unknown[];
}

interface BraveSource {
  title?: string;
  hostname?: string;
  age?: unknown;
}

interface BraveResponse {
  grounding?: {
    generic?: BraveSnippetGroup[];
    poi?: BravePoi | null;
    map?: BraveMap[];
  };
  sources?: Record<string, BraveSource>;
}

export class WebSearchTool implements Tool {
  public readonly name = "web_search";
  public readonly description: string;
  public readonly inputSchema = SCHEMA;
  public readonly capabilities: CapabilitySet;
  public readonly secrets: SecretNeeds;
  private readonly config: WebSearchConfig;
  private readonly endpoint: string;
  private readonly secretName: string;

  constructor(config: ToolConfig, capabilities: CapabilitySet | undefined) {
    this.capabilities = capabilities ?? {};
    this.config = parseConfig(config);
    this.endpoint = this.config.endpoint ?? DEFAULT_ENDPOINT;
    this.secretName = this.config.secret_name ?? DEFAULT_SECRET_NAME;
    this.secrets = { required: [this.secretName] };
    this.description = describe(this.config, this.secretName);
  }

  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    // Schema-validated upstream by ToolTable.
    const i = input as WebSearchInput;
    const apiKey = ctx.secrets[this.secretName];
    if (!apiKey) {
      return {
        content: `web_search: missing required secret '${this.secretName}'. Set it in the environment or your secrets store.`,
        isError: true,
      };
    }

    const body = buildRequestBody(i, this.config);

    const baseDisplay: ToolDisplay = {
      title: `Web search: ${truncate(i.query, 80)}`,
      kind: "fetch",
    };

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
        body: JSON.stringify(body),
        signal: ctx.abortSignal,
      });
    } catch (e) {
      const err = e as Error & { name?: string };
      if (err.name === "AbortError") {
        return {
          content: "web_search: aborted",
          isError: true,
          display: baseDisplay,
        };
      }
      return {
        content: `web_search: network error: ${err.message}`,
        isError: true,
        display: baseDisplay,
      };
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      return {
        content:
          `web_search: Brave API returned ${response.status} ${response.statusText}` +
          (text ? `\n${truncate(text, 1000)}` : ""),
        isError: true,
        display: baseDisplay,
      };
    }

    let data: BraveResponse;
    try {
      data = (await response.json()) as BraveResponse;
    } catch (e) {
      return {
        content: `web_search: failed to parse Brave API response: ${(e as Error).message}`,
        isError: true,
        display: baseDisplay,
      };
    }

    const rendered = renderResults(i.query, data);
    return {
      content: rendered,
      display: { ...baseDisplay, rawOutput: data },
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseConfig(raw: ToolConfig): WebSearchConfig {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      "web_search: expected an object config (or omit `[tools.web_search]` entirely).",
    );
  }
  const c = raw as Record<string, unknown>;
  const out: WebSearchConfig = {};

  assignString(c, out, "endpoint");
  assignString(c, out, "secret_name");
  assignString(c, out, "freshness", FRESHNESS_PATTERN);
  assignString(c, out, "country");
  assignString(c, out, "search_lang");

  assignInt(c, out, "count", 1, 50);
  assignInt(c, out, "max_urls", 1, 50);
  assignInt(c, out, "max_tokens", 1024, 32768);
  assignInt(c, out, "max_snippets", 1, 100);
  assignInt(c, out, "max_tokens_per_url", 512, 8192);
  assignInt(c, out, "max_snippets_per_url", 1, 100);

  if (c.threshold_mode !== undefined) {
    if (
      typeof c.threshold_mode !== "string" ||
      !THRESHOLD_MODES.includes(c.threshold_mode as ThresholdMode)
    ) {
      throw new Error(
        `web_search: 'threshold_mode' must be one of ${THRESHOLD_MODES.join(", ")}`,
      );
    }
    out.threshold_mode = c.threshold_mode as ThresholdMode;
  }

  if (c.enable_local !== undefined) {
    if (typeof c.enable_local !== "boolean") {
      throw new Error("web_search: 'enable_local' must be a boolean");
    }
    out.enable_local = c.enable_local;
  }

  if (c.goggles !== undefined) {
    if (typeof c.goggles === "string") {
      out.goggles = c.goggles;
    } else if (
      Array.isArray(c.goggles) &&
      c.goggles.every((g) => typeof g === "string")
    ) {
      out.goggles = c.goggles as string[];
    } else {
      throw new Error(
        "web_search: 'goggles' must be a string or string array",
      );
    }
  }

  return out;
}

function assignString(
  c: Record<string, unknown>,
  out: WebSearchConfig,
  key: keyof WebSearchConfig,
  pattern?: string,
): void {
  const v = c[key as string];
  if (v === undefined) return;
  if (typeof v !== "string") {
    throw new Error(`web_search: '${String(key)}' must be a string`);
  }
  if (pattern && !new RegExp(pattern).test(v)) {
    throw new Error(`web_search: '${String(key)}' does not match ${pattern}`);
  }
  (out as Record<string, unknown>)[key as string] = v;
}

function assignInt(
  c: Record<string, unknown>,
  out: WebSearchConfig,
  key: keyof WebSearchConfig,
  min: number,
  max: number,
): void {
  const v = c[key as string];
  if (v === undefined) return;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new Error(`web_search: '${String(key)}' must be an integer`);
  }
  if (v < min || v > max) {
    throw new Error(
      `web_search: '${String(key)}' must be in [${min}, ${max}], got ${v}`,
    );
  }
  (out as Record<string, unknown>)[key as string] = v;
}

function buildRequestBody(
  input: WebSearchInput,
  config: WebSearchConfig,
): Record<string, unknown> {
  const body: Record<string, unknown> = { q: input.query };

  // Input-level overrides take precedence over config defaults.
  const count = input.count ?? config.count;
  const freshness = input.freshness ?? config.freshness;

  if (count !== undefined) body.count = count;
  if (freshness !== undefined) body.freshness = freshness;
  if (config.country) body.country = config.country;
  if (config.search_lang) body.search_lang = config.search_lang;
  if (config.max_urls !== undefined)
    body.maximum_number_of_urls = config.max_urls;
  if (config.max_tokens !== undefined)
    body.maximum_number_of_tokens = config.max_tokens;
  if (config.max_snippets !== undefined)
    body.maximum_number_of_snippets = config.max_snippets;
  if (config.max_tokens_per_url !== undefined)
    body.maximum_number_of_tokens_per_url = config.max_tokens_per_url;
  if (config.max_snippets_per_url !== undefined)
    body.maximum_number_of_snippets_per_url = config.max_snippets_per_url;
  if (config.threshold_mode)
    body.context_threshold_mode = config.threshold_mode;
  if (config.enable_local !== undefined)
    body.enable_local = config.enable_local;
  if (config.goggles !== undefined) body.goggles = config.goggles;

  return body;
}

/**
 * Render the Brave LLM Context response as model-facing markdown.
 *
 * Layout:
 *   # Search results for "<query>"
 *   ## <title>
 *   <hostname> — <age?>
 *   <url>
 *   - <snippet>
 *   - <snippet>
 *
 * POI / map results (only present with local recall) are appended
 * after the generic results in dedicated sections.
 */
function renderResults(query: string, data: BraveResponse): string {
  const generic = data.grounding?.generic ?? [];
  const poi = data.grounding?.poi ?? null;
  const map = data.grounding?.map ?? [];
  const sources = data.sources ?? {};

  if (generic.length === 0 && !poi && map.length === 0) {
    return `No results for "${query}". Try a different query or broaden the freshness window.`;
  }

  const lines: string[] = [`# Search results for "${query}"`, ""];

  for (const group of generic) {
    const url = group.url ?? "";
    const title = group.title ?? url ?? "(untitled)";
    const meta = sources[url];
    lines.push(`## ${title}`);
    if (meta?.hostname || ageString(meta?.age)) {
      const parts: string[] = [];
      if (meta?.hostname) parts.push(meta.hostname);
      const age = ageString(meta?.age);
      if (age) parts.push(age);
      lines.push(parts.join(" — "));
    }
    if (url) lines.push(url);
    lines.push("");
    for (const s of group.snippets ?? []) {
      lines.push(`- ${snippetToString(s)}`);
    }
    lines.push("");
  }

  if (poi && (poi.name || poi.title || poi.url)) {
    lines.push("## Point of interest");
    if (poi.name) lines.push(`**${poi.name}**`);
    if (poi.url) lines.push(poi.url);
    lines.push("");
    for (const s of poi.snippets ?? []) {
      lines.push(`- ${snippetToString(s)}`);
    }
    lines.push("");
  }

  if (map.length > 0) {
    lines.push("## Places");
    for (const place of map) {
      const head = place.name ?? place.title ?? place.url ?? "(unnamed)";
      lines.push(`### ${head}`);
      if (place.url) lines.push(place.url);
      lines.push("");
      for (const s of place.snippets ?? []) {
        lines.push(`- ${snippetToString(s)}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

function snippetToString(s: unknown): string {
  if (typeof s === "string") return s.trim();
  // Brave may return JSON-serialised structured content (tables, code
  // blocks). Pretty-print it so the model sees the shape.
  try {
    return JSON.stringify(s);
  } catch {
    return String(s);
  }
}

function ageString(age: unknown): string {
  if (!Array.isArray(age) || age.length === 0) return "";
  // Brave returns [pretty, iso, relative]; prefer the relative form
  // ("380 days ago") if present, else the pretty form.
  const relative = age[2];
  if (typeof relative === "string") return relative;
  const pretty = age[0];
  if (typeof pretty === "string") return pretty;
  return "";
}

function describe(config: WebSearchConfig, secretName: string): string {
  const parts: string[] = [
    "Search the web via the Brave LLM Context API. Returns pre-extracted, snippet-formatted results optimized for grounding — no scraping required.",
  ];
  const defaults: string[] = [];
  if (config.count !== undefined) defaults.push(`count=${config.count}`);
  if (config.freshness) defaults.push(`freshness=${config.freshness}`);
  if (config.country) defaults.push(`country=${config.country}`);
  if (config.threshold_mode)
    defaults.push(`threshold=${config.threshold_mode}`);
  if (config.max_tokens !== undefined)
    defaults.push(`max_tokens=${config.max_tokens}`);
  if (defaults.length > 0) {
    parts.push(`Defaults: ${defaults.join(", ")}.`);
  }
  parts.push(
    `Requires the \`${secretName}\` secret (Brave Search API subscription token).`,
  );
  return parts.join(" ");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

async function safeReadText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return "";
  }
}
