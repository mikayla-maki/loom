import { describe, expect, it } from "vitest";
import {
  assertKnownKinds,
  assertRequires,
  assertSecretAllowlist,
  containsWithTool,
  defaultContains,
  defaultMerge,
  grantFor,
  grantRows,
  isStarSet,
  kindGranted,
  mergeWithTool,
  valueFor,
} from "../src/manifest/capabilities.js";
import { CapabilityError, SecretError } from "../src/errors.js";
import type { Tool } from "../src/types/interfaces.js";
import type { CapabilitySet } from "../src/types/manifest.js";

function makeTool(opts: {
  name: string;
  requires?: string[];
  optional?: string[];
  capabilities?: CapabilitySet;
  secrets?: { required?: string[]; optional?: string[] };
}): Tool {
  return {
    name: opts.name,
    description: `synthetic ${opts.name}`,
    inputSchema: { type: "object" },
    ...(opts.requires ? { requires: opts.requires } : {}),
    ...(opts.optional ? { optional: opts.optional } : {}),
    ...(opts.capabilities !== undefined
      ? { capabilities: opts.capabilities }
      : {}),
    ...(opts.secrets ? { secrets: opts.secrets } : {}),
    async execute() {
      return { content: "" };
    },
  };
}

function toolMap(...tools: Tool[]): Map<string, Tool> {
  return new Map(tools.map((t) => [t.name, t]));
}

/** Runs `fn`, returning the thrown error (failing the test if it doesn't throw). */
function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected function to throw");
}

describe("grant lookup helpers", () => {
  it("grantFor returns the manifest entry or undefined", () => {
    expect(grantFor({ a: { paths: ["/x"] } }, "a")).toEqual({ paths: ["/x"] });
    expect(grantFor({ a: { paths: ["/x"] } }, "missing")).toBeUndefined();
    expect(grantFor(undefined, "a")).toBeUndefined();
  });

  it("isStarSet detects whole-tool star grants", () => {
    expect(isStarSet("*")).toBe(true);
    expect(isStarSet({ paths: "*" })).toBe(false);
    expect(isStarSet(undefined)).toBe(false);
  });

  it("kindGranted treats `*` as authorising every kind", () => {
    expect(kindGranted("*", "anything")).toBe(true);
    expect(kindGranted({ paths: ["/x"] }, "paths")).toBe(true);
    expect(kindGranted({ paths: ["/x"] }, "network")).toBe(false);
    expect(kindGranted(undefined, "paths")).toBe(false);
  });

  it("valueFor returns the kind-level value, with `*` propagating", () => {
    expect(valueFor("*", "paths")).toBe("*");
    expect(valueFor({ paths: ["/x"] }, "paths")).toEqual(["/x"]);
    expect(valueFor({ paths: "*" }, "paths")).toBe("*");
    expect(valueFor({ paths: ["/x"] }, "network")).toBeUndefined();
    expect(valueFor(undefined, "paths")).toBeUndefined();
  });

  it("grantRows normalises a set to `*` or its row array", () => {
    expect(grantRows("*")).toBe("*");
    expect(grantRows({ paths: ["./"] })).toEqual([{ paths: ["./"] }]);
    expect(grantRows([{ paths: ["./"] }, { network: "*" }])).toEqual([
      { paths: ["./"] },
      { network: "*" },
    ]);
  });
});

describe("defaultContains (audit subset)", () => {
  it("undefined superset contains only an undefined or empty request", () => {
    expect(defaultContains(undefined, undefined)).toBe(true);
    expect(defaultContains(undefined, {})).toBe(true);
    expect(defaultContains(undefined, [{}, {}])).toBe(true);
    expect(defaultContains(undefined, { foo: ["x"] })).toBe(false);
    expect(defaultContains(undefined, "*")).toBe(false);
    expect(defaultContains({ paths: ["./"] }, undefined)).toBe(true);
  });

  it("an absent kind in the superset denies the request", () => {
    expect(defaultContains({ paths: ["./"] }, { network: "*" })).toBe(false);
    expect(
      defaultContains({ paths: ["./"] }, { paths: ["./"], network: "*" }),
    ).toBe(false);
    expect(defaultContains({}, { paths: ["./"] })).toBe(false);
  });

  it("row sets: each subset row must fit within a single superset row", () => {
    const superset = [{ paths: ["/a"] }, { network: "*" }];
    expect(defaultContains(superset, { paths: ["/a"] })).toBe(true);
    expect(defaultContains(superset, { network: "*" })).toBe(true);
    expect(
      defaultContains(superset, [{ paths: ["/a"] }, { network: "*" }]),
    ).toBe(true);
    // Spans rows: no single superset row authorises both kinds at once.
    expect(defaultContains(superset, { paths: ["/a"], network: "*" })).toBe(
      false,
    );
  });

  it("`*` superset contains anything; `*` subset only contained by `*`", () => {
    expect(defaultContains("*", { paths: ["/x"] })).toBe(true);
    expect(defaultContains("*", "*")).toBe(true);
    expect(defaultContains({ paths: "*" }, "*")).toBe(false);
  });

  it("array containment: every subset item must appear in superset", () => {
    expect(defaultContains(["a", "b", "c"], ["a", "c"])).toBe(true);
    expect(defaultContains(["a", "b"], ["a", "b"])).toBe(true);
    expect(defaultContains(["a"], ["a", "b"])).toBe(false);
  });

  it("recurses into nested objects with array fields", () => {
    expect(
      defaultContains(
        { paths: ["./", "./a"], tags: ["x"] },
        { paths: ["./a"] },
      ),
    ).toBe(true);
    expect(
      defaultContains({ paths: ["./a"] }, { paths: ["./a", "/etc"] }),
    ).toBe(false);
  });

  it("primitive containment is deep-equal; type mismatches fail", () => {
    expect(defaultContains("foo", "foo")).toBe(true);
    expect(defaultContains("foo", "bar")).toBe(false);
    expect(defaultContains(["a"], { a: 1 })).toBe(false);
  });
});

describe("defaultMerge", () => {
  it("`*` absorbs either side", () => {
    expect(defaultMerge("*", { paths: ["./"] })).toBe("*");
    expect(defaultMerge({ paths: ["./"] }, "*")).toBe("*");
    expect(defaultMerge("*", "*")).toBe("*");
  });

  it("unions row sets, deduplicating identical rows", () => {
    expect(defaultMerge({ paths: ["/a"] }, { network: "*" })).toEqual([
      { paths: ["/a"] },
      { network: "*" },
    ]);
    expect(defaultMerge({ paths: ["/a"] }, { paths: ["/a"] })).toEqual({
      paths: ["/a"],
    });
    expect(
      defaultMerge([{ paths: ["/a"] }, { network: "*" }], { paths: ["/b"] }),
    ).toEqual([{ paths: ["/a"] }, { network: "*" }, { paths: ["/b"] }]);
  });

  it("never widens: distinct rows stay rows, not a kind-wise bounding box", () => {
    const merged = defaultMerge({ paths: ["/a"] }, { network: "*" });
    expect(merged).toEqual([{ paths: ["/a"] }, { network: "*" }]);
    expect(defaultContains(merged, { paths: ["/a"], network: "*" })).toBe(
      false,
    );
  });
});

describe("tool-defined capability algebra", () => {
  it("containsWithTool delegates to the tool's containsGrant when present", () => {
    const permissive: Tool = {
      ...makeTool({ name: "permissive" }),
      containsGrant: () => true,
    };
    expect(containsWithTool(permissive, { paths: [] }, { network: "*" })).toBe(
      true,
    );
    expect(containsWithTool(undefined, { paths: [] }, { network: "*" })).toBe(
      false,
    );
  });

  it("mergeWithTool falls back to the default row union", () => {
    expect(
      mergeWithTool(undefined, { paths: ["/a"] }, { network: "*" }),
    ).toEqual([{ paths: ["/a"] }, { network: "*" }]);
  });

  it("mergeWithTool throws when a tool's merge violates the containment law", () => {
    const broken: Tool = {
      ...makeTool({ name: "broken" }),
      mergeGrants: () => ({}),
    };
    const caught = catchError(() =>
      mergeWithTool(broken, { paths: ["/a"] }, { network: "*" }),
    );
    expect(caught).toBeInstanceOf(CapabilityError);
    expect(String(caught)).toContain("merge law violated by tool 'broken'");
  });
});

describe("assertRequires", () => {
  it("passes when requirements are absent or satisfied", () => {
    const echo = toolMap(makeTool({ name: "echo" }));
    expect(() => assertRequires(echo, undefined)).not.toThrow();
    expect(() => assertRequires(echo, {})).not.toThrow();

    const bash = toolMap(
      makeTool({ name: "bash", requires: ["commands", "net"] }),
    );
    expect(() =>
      assertRequires(bash, { bash: { commands: "*", net: "*" } }),
    ).not.toThrow();
    expect(() => assertRequires(bash, { bash: "*" })).not.toThrow();
  });

  it("throws when a required kind is missing from the grant", () => {
    const tools = toolMap(makeTool({ name: "bash", requires: ["commands"] }));
    expect(() => assertRequires(tools, {})).toThrow(CapabilityError);
    expect(() => assertRequires(tools, { bash: {} })).toThrow(CapabilityError);
  });

  it("aggregates multiple violations across tools into one error", () => {
    const tools = toolMap(
      makeTool({ name: "a", requires: ["x"] }),
      makeTool({ name: "b", requires: ["y", "z"] }),
    );
    const caught = catchError(() =>
      assertRequires(tools, { a: {}, b: { y: "*" } }),
    );
    expect(caught).toBeInstanceOf(CapabilityError);
    expect(String(caught)).toContain("a");
    expect(String(caught)).toContain("'x'");
    expect(String(caught)).toContain("b");
    expect(String(caught)).toContain("'z'");
  });
});

describe("assertKnownKinds", () => {
  it("passes for absent caps, star grants, empty grants, and declared kinds", () => {
    const echo = toolMap(makeTool({ name: "echo" }));
    expect(() => assertKnownKinds(echo, undefined)).not.toThrow();
    expect(() => assertKnownKinds(echo, { echo: {} })).not.toThrow();

    const bash = toolMap(
      makeTool({
        name: "bash",
        requires: ["commands"],
        optional: ["paths", "network"],
      }),
    );
    expect(() => assertKnownKinds(bash, { bash: "*" })).not.toThrow();
    expect(() =>
      assertKnownKinds(bash, {
        bash: { commands: "*", paths: ["./"], network: "*" },
      }),
    ).not.toThrow();
  });

  it("throws on an undeclared granted kind and suggests the intended name", () => {
    const tools = toolMap(makeTool({ name: "read_file", optional: ["paths"] }));
    const caught = catchError(() =>
      assertKnownKinds(tools, { read_file: { pahts: ["./"] } }),
    );
    expect(caught).toBeInstanceOf(CapabilityError);
    expect(String(caught)).toContain("read_file");
    expect(String(caught)).toContain("'pahts'");
    expect(String(caught)).toContain("'paths'");
  });

  it("throws when a tool with no declared kinds receives a structured grant", () => {
    const tools = toolMap(makeTool({ name: "echo" }));
    expect(() => assertKnownKinds(tools, { echo: { paths: ["./"] } })).toThrow(
      CapabilityError,
    );
  });

  it("aggregates violations across multiple tools", () => {
    const tools = toolMap(
      makeTool({ name: "a", optional: ["x"] }),
      makeTool({ name: "b", optional: ["y"] }),
    );
    const caught = catchError(() =>
      assertKnownKinds(tools, { a: { z: "*" }, b: { wat: "*" } }),
    );
    expect(caught).toBeInstanceOf(CapabilityError);
    expect(String(caught)).toContain("'z'");
    expect(String(caught)).toContain("'wat'");
  });
});

describe("assertSecretAllowlist", () => {
  it("absent allowlist or `*` passes any secret needs", () => {
    const tools = toolMap(
      makeTool({ name: "s3", secrets: { required: ["AWS_ACCESS_KEY_ID"] } }),
    );
    expect(() => assertSecretAllowlist(tools, undefined)).not.toThrow();
    expect(() => assertSecretAllowlist(tools, "*")).not.toThrow();
  });

  it("passes when every needed secret is in the allowlist", () => {
    const tools = toolMap(
      makeTool({
        name: "s3",
        secrets: { required: ["AWS_ACCESS_KEY_ID"], optional: ["AWS_REGION"] },
      }),
    );
    expect(() =>
      assertSecretAllowlist(tools, ["AWS_ACCESS_KEY_ID", "AWS_REGION"]),
    ).not.toThrow();
  });

  it("throws when a needed secret is outside the allowlist", () => {
    const tools = toolMap(
      makeTool({
        name: "s3",
        secrets: { required: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] },
      }),
    );
    expect(() => assertSecretAllowlist(tools, ["AWS_ACCESS_KEY_ID"])).toThrow(
      SecretError,
    );
  });

  it("empty allowlist denies any tool that wants a secret", () => {
    const tools = toolMap(
      makeTool({ name: "fetch", secrets: { optional: ["BEARER_TOKEN"] } }),
    );
    expect(() => assertSecretAllowlist(tools, [])).toThrow(SecretError);
  });
});
