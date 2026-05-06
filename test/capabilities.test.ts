import { describe, expect, it } from "vitest";
import { assertSubset, unionCapabilities } from "../src/manifest/capabilities.js";
import { CapabilityError } from "../src/errors.js";

describe("unionCapabilities", () => {
  it("unions and dedupes string-array axes", () => {
    const u = unionCapabilities([
      { filesystem: ["./", "./a"], network: ["x.com"] },
      { filesystem: ["./a", "./b"], network: ["y.com", "x.com"] },
    ]);
    expect(u.filesystem).toEqual(expect.arrayContaining(["./", "./a", "./b"]));
    expect(u.network).toEqual(expect.arrayContaining(["x.com", "y.com"]));
  });

  it("preserves wildcard subagent", () => {
    const u = unionCapabilities([{ subagent: "*" }, { subagent: ["a"] }]);
    expect(u.subagent).toBe("*");
  });
});

describe("assertSubset", () => {
  it("accepts when ceiling covers required (path prefix containment)", () => {
    expect(() =>
      assertSubset({ filesystem: ["./a/b"] }, { filesystem: ["./a"] }),
    ).not.toThrow();
  });

  it("rejects when filesystem path is outside ceiling", () => {
    expect(() =>
      assertSubset({ filesystem: ["/etc/passwd"] }, { filesystem: ["./a"] }),
    ).toThrow(CapabilityError);
  });

  it("matches network wildcards (*.example.com)", () => {
    expect(() =>
      assertSubset(
        { network: ["api.example.com", "example.com"] },
        { network: ["*.example.com"] },
      ),
    ).not.toThrow();
    expect(() =>
      assertSubset({ network: ["other.com"] }, { network: ["*.example.com"] }),
    ).toThrow(CapabilityError);
  });

  it("respects literal secrets membership", () => {
    expect(() =>
      assertSubset({ secrets: ["a"] }, { secrets: ["a", "b"] }),
    ).not.toThrow();
    expect(() =>
      assertSubset({ secrets: ["c"] }, { secrets: ["a", "b"] }),
    ).toThrow(CapabilityError);
  });

  it("subagent: '*' requires ceiling '*'", () => {
    expect(() => assertSubset({ subagent: "*" }, { subagent: ["a"] })).toThrow(
      CapabilityError,
    );
    expect(() => assertSubset({ subagent: "*" }, { subagent: "*" })).not.toThrow();
  });
});
