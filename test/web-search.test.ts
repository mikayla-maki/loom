/**
 * Tests for the `web_search` builtin (Brave LLM Context API).
 *
 * Covers:
 *   - happy path: fetch is called with the right shape; results render
 *     as markdown
 *   - input.freshness / input.count override the configured defaults
 *   - missing API key returns an isError result, doesn't hit the API
 *   - non-2xx response is surfaced as an error
 *   - registered in the native provider under the name "web_search"
 *   - end-to-end: runAgent → tool call → rendered content
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { WebSearchTool } from "../src/runtime/builtins/web_search.js";
import { runAgent } from "../src/sdk/run-agent.js";
import { StaticSecretsStore } from "../src/runtime/secrets.js";
import {
  buildNativeTools,
  nativeBuiltinNames,
} from "../src/builtins/tools/native.js";
import type {
  Agent,
  ToolContext,
  ToolResult,
} from "../src/types/interfaces.js";

// ─── fetch stubbing helpers ──────────────────────────────────────────────

type FetchCall = { url: string; init: RequestInit };

interface FetchStub {
  calls: FetchCall[];
  respond: (body: unknown, init?: { status?: number; ok?: boolean }) => void;
  restore: () => void;
}

function stubFetch(): FetchStub {
  const original = global.fetch;
  const calls: FetchCall[] = [];
  let body: unknown = {};
  let status = 200;
  global.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const response = new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
    return Promise.resolve(response);
  }) as typeof fetch;
  return {
    calls,
    respond(b, opts) {
      body = b;
      status = opts?.status ?? 200;
    },
    restore() {
      global.fetch = original;
    },
  };
}

// Minimal ToolContext stub. The web_search tool only reads
// `ctx.secrets` and `ctx.abortSignal`; everything else can be dummies.
function buildCtx(secrets: Record<string, string>): ToolContext {
  return {
    secrets,
    abortSignal: new AbortController().signal,
    requestPermission: async () => {
      throw new Error("unused");
    },
    agent: {} as Agent,
  };
}

// A minimal sample Brave response we can vary across tests.
const SAMPLE_RESPONSE = {
  grounding: {
    generic: [
      {
        url: "https://example.com/page",
        title: "Example Page",
        snippets: ["first snippet", "second snippet"],
      },
      {
        url: "https://other.example/x",
        title: "Other",
        snippets: ["only one"],
      },
    ],
    map: [],
  },
  sources: {
    "https://example.com/page": {
      title: "Example Page",
      hostname: "example.com",
      age: ["Monday, January 15, 2024", "2024-01-15", "380 days ago"],
    },
    "https://other.example/x": {
      title: "Other",
      hostname: "other.example",
      age: null,
    },
  },
};

// ─── Direct-construction tests ───────────────────────────────────────────

describe("web_search tool (direct)", () => {
  let stub: FetchStub;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("declares the BRAVE_SEARCH_API_KEY secret by default", () => {
    const tool = new WebSearchTool({}, undefined);
    expect(tool.secrets?.required).toEqual(["BRAVE_SEARCH_API_KEY"]);
    expect(tool.name).toBe("web_search");
    expect(tool.description).toMatch(/Brave/);
    expect(tool.description).toMatch(/BRAVE_SEARCH_API_KEY/);
  });

  it("calls the Brave endpoint with the right shape", async () => {
    stub.respond(SAMPLE_RESPONSE);
    const tool = new WebSearchTool({}, undefined);
    const result = await tool.execute(
      { query: "mount everest height" },
      buildCtx({ BRAVE_SEARCH_API_KEY: "sk-test" }),
    );

    expect(result.isError).toBeUndefined();
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    const { url, init } = call;
    expect(url).toBe("https://api.search.brave.com/res/v1/llm/context");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Subscription-Token"]).toBe("sk-test");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ q: "mount everest height" });
  });

  it("renders results as markdown the model can read", async () => {
    stub.respond(SAMPLE_RESPONSE);
    const tool = new WebSearchTool({}, undefined);
    const result = (await tool.execute(
      { query: "examples" },
      buildCtx({ BRAVE_SEARCH_API_KEY: "k" }),
    )) as ToolResult;
    expect(result.content).toMatch(/^# Search results for "examples"/);
    expect(result.content).toContain("## Example Page");
    expect(result.content).toContain("example.com");
    expect(result.content).toContain("380 days ago");
    expect(result.content).toContain("https://example.com/page");
    expect(result.content).toContain("- first snippet");
    expect(result.content).toContain("- second snippet");
    expect(result.content).toContain("## Other");
    expect(result.display?.kind).toBe("fetch");
    expect(result.display?.rawOutput).toEqual(SAMPLE_RESPONSE);
  });

  it("renders empty results gracefully", async () => {
    stub.respond({ grounding: { generic: [], map: [] }, sources: {} });
    const tool = new WebSearchTool({}, undefined);
    const result = await tool.execute(
      { query: "nothing-ever-matches-this" },
      buildCtx({ BRAVE_SEARCH_API_KEY: "k" }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/No results for/);
  });

  it("passes config-level defaults to the API body", async () => {
    stub.respond(SAMPLE_RESPONSE);
    const tool = new WebSearchTool(
      {
        count: 5,
        freshness: "pm",
        country: "us",
        threshold_mode: "strict",
        max_tokens: 4096,
      },
      undefined,
    );
    await tool.execute(
      { query: "react hooks" },
      buildCtx({ BRAVE_SEARCH_API_KEY: "k" }),
    );
    const body = JSON.parse(String(stub.calls[0]?.init.body));
    expect(body).toEqual({
      q: "react hooks",
      count: 5,
      freshness: "pm",
      country: "us",
      context_threshold_mode: "strict",
      maximum_number_of_tokens: 4096,
    });
  });

  it("input.freshness and input.count override config defaults", async () => {
    stub.respond(SAMPLE_RESPONSE);
    const tool = new WebSearchTool({ count: 5, freshness: "pm" }, undefined);
    await tool.execute(
      { query: "fresh news", freshness: "pd", count: 10 },
      buildCtx({ BRAVE_SEARCH_API_KEY: "k" }),
    );
    const body = JSON.parse(String(stub.calls[0]?.init.body));
    expect(body.freshness).toBe("pd");
    expect(body.count).toBe(10);
  });

  it("respects a custom endpoint and secret_name", async () => {
    stub.respond(SAMPLE_RESPONSE);
    const tool = new WebSearchTool(
      { endpoint: "https://example.test/search", secret_name: "MY_KEY" },
      undefined,
    );
    expect(tool.secrets?.required).toEqual(["MY_KEY"]);
    await tool.execute({ query: "x" }, buildCtx({ MY_KEY: "tok" }));
    expect(stub.calls[0]?.url).toBe("https://example.test/search");
    const headers = stub.calls[0]?.init.headers as Record<string, string>;
    expect(headers["X-Subscription-Token"]).toBe("tok");
  });

  it("returns an error (without calling fetch) when the secret is absent", async () => {
    const tool = new WebSearchTool({}, undefined);
    const result = await tool.execute({ query: "x" }, buildCtx({}));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/missing required secret/);
    expect(stub.calls).toHaveLength(0);
  });

  it("surfaces a non-OK response as an isError result", async () => {
    stub.respond({ error: "rate-limited" }, { status: 429 });
    const tool = new WebSearchTool({}, undefined);
    const result = await tool.execute(
      { query: "x" },
      buildCtx({ BRAVE_SEARCH_API_KEY: "k" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/429/);
  });

  it("rejects malformed configs at construction time", () => {
    expect(
      () =>
        new WebSearchTool(
          { threshold_mode: "nope" } as unknown as Record<string, unknown>,
          undefined,
        ),
    ).toThrow(/threshold_mode/);
    expect(
      () =>
        new WebSearchTool(
          { count: 999 } as unknown as Record<string, unknown>,
          undefined,
        ),
    ).toThrow(/count/);
    expect(
      () =>
        new WebSearchTool(
          { freshness: "bogus" } as unknown as Record<string, unknown>,
          undefined,
        ),
    ).toThrow(/freshness/);
  });

  it("renders POI and map sections when local recall is on", async () => {
    stub.respond({
      grounding: {
        generic: [],
        poi: {
          name: "Blue Bottle",
          url: "https://bluebottle.test",
          snippets: ["specialty coffee"],
        },
        map: [
          {
            name: "Sightglass",
            url: "https://sightglass.test",
            snippets: ["roastery"],
          },
        ],
      },
      sources: {},
    });
    const tool = new WebSearchTool({ enable_local: true }, undefined);
    const result = await tool.execute(
      { query: "coffee near me" },
      buildCtx({ BRAVE_SEARCH_API_KEY: "k" }),
    );
    expect(result.content).toContain("## Point of interest");
    expect(result.content).toContain("**Blue Bottle**");
    expect(result.content).toContain("## Places");
    expect(result.content).toContain("### Sightglass");
    const body = JSON.parse(String(stub.calls[0]?.init.body));
    expect(body.enable_local).toBe(true);
  });
});

// ─── Native registration ─────────────────────────────────────────────────

describe("web_search native registration", () => {
  it("is listed among the native builtin names", () => {
    expect(nativeBuiltinNames()).toContain("web_search");
  });

  it("native provider resolves web_search to a WebSearchTool instance", async () => {
    const native = buildNativeTools();
    const tool = await native.resolveTool(
      "web_search",
      {},
      {} as Agent,
      undefined,
    );
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("web_search");
  });
});

// ─── End-to-end through runAgent ────────────────────────────────────────

describe("web_search end-to-end via runAgent", () => {
  let stub: FetchStub;
  beforeEach(() => {
    stub = stubFetch();
  });
  afterEach(() => {
    stub.restore();
  });

  it("model calls web_search; tool surfaces rendered results", async () => {
    stub.respond(SAMPLE_RESPONSE);
    const agent = await runAgent(
      {
        name: "web-search-e2e",
        systemPrompt: "be brief",
        harness: {
          provider: "test",
          script: [
            [
              {
                call: {
                  tool: "web_search",
                  input: { query: "what is loom" },
                },
                surface: true,
              },
              { stop: "end_turn" },
            ],
          ],
        },
        tools: { web_search: "builtin" },
      },
      {
        secrets: new StaticSecretsStore({ BRAVE_SEARCH_API_KEY: "k" }),
      },
    );
    try {
      await agent.prompt("go");
      const events = (await agent.session.pull?.([])) ?? [];
      const tcus = events.filter((e) => e.sessionUpdate === "tool_call_update");
      expect(tcus).toHaveLength(1);
      const update = tcus[0];
      if (!update || update.sessionUpdate !== "tool_call_update") {
        throw new Error("expected tool_call_update");
      }
      expect(update.status).toBe("completed");
      const text =
        update.content?.[0]?.type === "content" &&
        update.content[0].content.type === "text"
          ? update.content[0].content.text
          : "";
      expect(text).toContain("Example Page");
      expect(text).toContain("first snippet");
    } finally {
      await agent.close();
    }
  });

  it("boot fails when the BRAVE_SEARCH_API_KEY secret is missing", async () => {
    await expect(
      runAgent(
        {
          name: "web-search-missing-secret",
          systemPrompt: "x",
          harness: { provider: "test" },
          tools: { web_search: "builtin" },
        },
        { secrets: new StaticSecretsStore({}) },
      ),
    ).rejects.toThrow(/BRAVE_SEARCH_API_KEY/);
  });
});
