import { describe, expect, it } from "vitest";
import {
  assertKnownKinds,
  assertRequires,
  assertSecretAllowlist,
  defaultContains,
  grantFor,
  isStarSet,
  kindGranted,
  valueFor,
} from "../src/manifest/capabilities.js";
import { CapabilityError, SecretError } from "../src/errors.js";
import type { Tool } from "../src/types/interfaces.js";
import type { CapabilitySet } from "../src/types/manifest.js";

/**
 * Synthetic Tool builder. We only care about the v2 fields:
 *   `requires`, `optional`, `capabilities`, `secrets`.
 */
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

describe("grant lookup helpers", () => {
  it("grantFor returns the manifest entry or undefined", () => {
    expect(grantFor({ a: { paths: ["/x"] } }, "a")).toEqual({
      paths: ["/x"],
    });
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
});

describe("defaultContains (audit subset)", () => {
  it("treats undefined superset/subset as trivially compatible", () => {
    expect(defaultContains(undefined, { foo: ["x"] })).toBe(true);
    expect(defaultContains({ paths: ["./"] }, undefined)).toBe(true);
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

describe("assertRequires", () => {
  it("passes when a tool has no `requires`", () => {
    const tools = new Map<string, Tool>([["echo", makeTool({ name: "echo" })]]);
    // No grant → still passes; nothing required.
    expect(() => assertRequires(tools, undefined)).not.toThrow();
    expect(() => assertRequires(tools, {})).not.toThrow();
  });

  it("passes when every required kind is granted", () => {
    const tools = new Map<string, Tool>([
      ["bash", makeTool({ name: "bash", requires: ["subprocess"] })],
    ]);
    expect(() =>
      assertRequires(tools, { bash: { subprocess: "*" } }),
    ).not.toThrow();
  });

  it("`*` whole-tool grant satisfies every requires", () => {
    const tools = new Map<string, Tool>([
      ["bash", makeTool({ name: "bash", requires: ["subprocess", "net"] })],
    ]);
    expect(() => assertRequires(tools, { bash: "*" })).not.toThrow();
  });

  it("throws when a required kind is missing from the grant", () => {
    const tools = new Map<string, Tool>([
      ["bash", makeTool({ name: "bash", requires: ["subprocess"] })],
    ]);
    expect(() => assertRequires(tools, {})).toThrow(CapabilityError);
    expect(() => assertRequires(tools, { bash: {} })).toThrow(CapabilityError);
  });

  it("aggregates multiple violations across tools into one error", () => {
    const tools = new Map<string, Tool>([
      ["a", makeTool({ name: "a", requires: ["x"] })],
      ["b", makeTool({ name: "b", requires: ["y", "z"] })],
    ]);
    let caught: unknown;
    try {
      assertRequires(tools, { a: {}, b: { y: "*" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CapabilityError);
    expect(String(caught)).toContain("a");
    expect(String(caught)).toContain("'x'");
    expect(String(caught)).toContain("b");
    expect(String(caught)).toContain("'z'");
  });
});

describe("assertKnownKinds", () => {
  it("absent capabilities passes trivially", () => {
    const tools = new Map<string, Tool>([["echo", makeTool({ name: "echo" })]]);
    expect(() => assertKnownKinds(tools, undefined)).not.toThrow();
  });

  it("`*` whole-tool grants are exempt from kind-checking", () => {
    const tools = new Map<string, Tool>([
      ["bash", makeTool({ name: "bash", requires: ["subprocess"] })],
    ]);
    // "*" doesn't list any kinds, so there's nothing to typo-check.
    expect(() => assertKnownKinds(tools, { bash: "*" })).not.toThrow();
  });

  it("empty grant `{}` passes (no keys to check)", () => {
    const tools = new Map<string, Tool>([["echo", makeTool({ name: "echo" })]]);
    expect(() => assertKnownKinds(tools, { echo: {} })).not.toThrow();
  });

  it("passes when every granted kind is declared (in requires or optional)", () => {
    const tools = new Map<string, Tool>([
      [
        "bash",
        makeTool({
          name: "bash",
          requires: ["subprocess"],
          optional: ["paths", "network"],
        }),
      ],
    ]);
    expect(() =>
      assertKnownKinds(tools, {
        bash: { subprocess: "*", paths: ["./"], network: "*" },
      }),
    ).not.toThrow();
  });

  it("throws when a granted kind isn't in requires or optional (typo)", () => {
    const tools = new Map<string, Tool>([
      ["read_file", makeTool({ name: "read_file", optional: ["paths"] })],
    ]);
    // `pahts` (typo) would silently do nothing under v1; v2 catches it.
    let caught: unknown;
    try {
      assertKnownKinds(tools, {
        read_file: { pahts: ["./"] },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CapabilityError);
    expect(String(caught)).toContain("read_file");
    expect(String(caught)).toContain("'pahts'");
    expect(String(caught)).toContain("'paths'");
  });

  it("throws when a tool with no declared kinds receives a structured grant", () => {
    // The footgun the user pointed at: `echo` doesn't read caps, but
    // the user grants `{ paths: ["./"] }` thinking it constrains the
    // tool. The check rejects this so the user notices.
    const tools = new Map<string, Tool>([["echo", makeTool({ name: "echo" })]]);
    expect(() => assertKnownKinds(tools, { echo: { paths: ["./"] } })).toThrow(
      CapabilityError,
    );
  });

  it("aggregates violations across multiple tools", () => {
    const tools = new Map<string, Tool>([
      ["a", makeTool({ name: "a", optional: ["x"] })],
      ["b", makeTool({ name: "b", optional: ["y"] })],
    ]);
    let caught: unknown;
    try {
      assertKnownKinds(tools, {
        a: { z: "*" },
        b: { wat: "*" },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CapabilityError);
    expect(String(caught)).toContain("'z'");
    expect(String(caught)).toContain("'wat'");
  });
});

describe("assertSecretAllowlist", () => {
  it("absent allowlist passes any secret needs", () => {
    const tools = new Map<string, Tool>([
      [
        "s3",
        makeTool({
          name: "s3",
          secrets: { required: ["AWS_ACCESS_KEY_ID"] },
        }),
      ],
    ]);
    expect(() => assertSecretAllowlist(tools, undefined)).not.toThrow();
    expect(() => assertSecretAllowlist(tools, "*")).not.toThrow();
  });

  it("allowlist passes when every needed name is in it", () => {
    const tools = new Map<string, Tool>([
      [
        "s3",
        makeTool({
          name: "s3",
          secrets: {
            required: ["AWS_ACCESS_KEY_ID"],
            optional: ["AWS_REGION"],
          },
        }),
      ],
    ]);
    expect(() =>
      assertSecretAllowlist(tools, ["AWS_ACCESS_KEY_ID", "AWS_REGION"]),
    ).not.toThrow();
  });

  it("throws when a tool wants a secret outside the allowlist", () => {
    const tools = new Map<string, Tool>([
      [
        "s3",
        makeTool({
          name: "s3",
          secrets: {
            required: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
          },
        }),
      ],
    ]);
    expect(() => assertSecretAllowlist(tools, ["AWS_ACCESS_KEY_ID"])).toThrow(
      SecretError,
    );
  });

  it("empty allowlist denies any tool that wants a secret", () => {
    const tools = new Map<string, Tool>([
      [
        "fetch",
        makeTool({
          name: "fetch",
          secrets: { optional: ["BEARER_TOKEN"] },
        }),
      ],
    ]);
    expect(() => assertSecretAllowlist(tools, [])).toThrow(SecretError);
  });
});
