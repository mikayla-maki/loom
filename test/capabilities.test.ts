import { describe, expect, it } from "vitest";
import {
  assertCapabilities,
  defaultContains,
} from "../src/manifest/capabilities.js";
import { CapabilityError } from "../src/errors.js";
import type { Tool } from "../src/types/interfaces.js";

/**
 * Synthetic Tool builder for these tests — we only care about the
 * `capabilities` (and optional `capabilitiesContain`) fields, plus the
 * structural surface `assertCapabilities` reads.
 */
function makeTool(
  name: string,
  capabilities: unknown,
  override?: Tool["capabilitiesContain"],
): Tool {
  return {
    name,
    description: `synthetic ${name}`,
    inputSchema: { type: "object" },
    capabilities,
    ...(override ? { capabilitiesContain: override } : {}),
    async execute() {
      return { content: "" };
    },
  };
}

describe("defaultContains", () => {
  it("treats undefined superset as unconstrained (contains anything)", () => {
    expect(defaultContains(undefined, { foo: ["x"] })).toBe(true);
    expect(defaultContains(undefined, "anything")).toBe(true);
  });

  it("treats undefined subset as trivially contained", () => {
    expect(defaultContains({ paths: ["./"] }, undefined)).toBe(true);
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

  it("primitive containment is deep-equal", () => {
    expect(defaultContains("foo", "foo")).toBe(true);
    expect(defaultContains("foo", "bar")).toBe(false);
    expect(defaultContains(5, 5)).toBe(true);
    expect(defaultContains(true, false)).toBe(false);
  });

  it("type mismatch (array vs object) fails", () => {
    expect(defaultContains(["a"], { a: 1 })).toBe(false);
    expect(defaultContains({ a: 1 }, ["a"])).toBe(false);
  });
});

describe("assertCapabilities", () => {
  it("passes when no sandbox entry matches the tool name", () => {
    const tools = new Map<string, Tool>([
      ["t", makeTool("t", { paths: ["/etc"] })],
    ]);
    expect(() => assertCapabilities(tools, {})).not.toThrow();
    expect(() =>
      assertCapabilities(tools, { other_tool: { paths: ["./"] } }),
    ).not.toThrow();
  });

  it("passes when the tool's caps fit inside its ceiling entry", () => {
    // defaultContains is structural string-equality on array items, so
    // these test inputs are pre-normalized to literal-equal strings.
    const tools = new Map<string, Tool>([
      ["read_file", makeTool("read_file", { paths: ["/proj"] })],
    ]);
    expect(() =>
      assertCapabilities(tools, {
        read_file: { paths: ["/proj", "/extra"] },
      }),
    ).not.toThrow();
  });

  it("throws CapabilityError when caps exceed the ceiling", () => {
    const tools = new Map<string, Tool>([
      ["read_file", makeTool("read_file", { paths: ["/etc"] })],
    ]);
    expect(() =>
      assertCapabilities(tools, { read_file: { paths: ["/proj"] } }),
    ).toThrow(CapabilityError);
  });

  it("tools with no declared capabilities pass unconditionally", () => {
    const tools = new Map<string, Tool>([
      [
        "echo",
        {
          name: "echo",
          description: "echo",
          inputSchema: { type: "object" },
          async execute() {
            return { content: "" };
          },
        },
      ],
    ]);
    // Even with a ceiling entry, no declared caps → nothing to check.
    expect(() =>
      assertCapabilities(tools, { echo: { paths: ["./"] } }),
    ).not.toThrow();
  });

  it("Tool.capabilitiesContain overrides the structural default", () => {
    // A tool that always rejects, regardless of structural shape.
    const reject = makeTool("strict", { paths: ["/proj"] }, () => false);
    const tools = new Map<string, Tool>([["strict", reject]]);
    expect(() =>
      assertCapabilities(tools, { strict: { paths: ["/proj"] } }),
    ).toThrow(CapabilityError);

    // A tool that always accepts, even when defaultContains would reject.
    const lax = makeTool("lax", { paths: ["/etc"] }, () => true);
    const tools2 = new Map<string, Tool>([["lax", lax]]);
    expect(() =>
      assertCapabilities(tools2, { lax: { paths: ["/proj"] } }),
    ).not.toThrow();
  });

  it("aggregates multiple violations into one error", () => {
    const tools = new Map<string, Tool>([
      ["a", makeTool("a", { paths: ["/etc"] })],
      ["b", makeTool("b", { paths: ["/var"] })],
    ]);
    let caught: unknown;
    try {
      assertCapabilities(tools, {
        a: { paths: ["/proj"] },
        b: { paths: ["/proj"] },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CapabilityError);
    expect(String(caught)).toContain("a");
    expect(String(caught)).toContain("b");
  });
});
