import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

import { pathGrantContains } from "../src/runtime/builtins/_path.js";
import { ReadFileTool } from "../src/runtime/builtins/read_file.js";
import { WriteFileTool } from "../src/runtime/builtins/write_file.js";
import { EditFileTool } from "../src/runtime/builtins/edit_file.js";
import { FindTool } from "../src/runtime/builtins/find.js";

describe("pathGrantContains path containment", () => {
  it("contains a path lexically under a superset root", () => {
    expect(
      pathGrantContains({ paths: ["./"] }, { paths: ["./src"] }),
    ).toBe(true);
    expect(
      pathGrantContains({ paths: ["./src"] }, { paths: ["./src/runtime/builtins"] }),
    ).toBe(true);
  });

  it("contains an exactly equal path", () => {
    expect(
      pathGrantContains({ paths: ["./src"] }, { paths: ["./src"] }),
    ).toBe(true);
    expect(
      pathGrantContains({ paths: ["/tmp/a"] }, { paths: ["/tmp/a"] }),
    ).toBe(true);
  });

  it("expands ~ on both sides before comparing", () => {
    const home = os.homedir();
    expect(
      pathGrantContains({ paths: ["~"] }, { paths: [path.join(home, "docs")] }),
    ).toBe(true);
    expect(
      pathGrantContains({ paths: [home] }, { paths: ["~/docs"] }),
    ).toBe(true);
    expect(
      pathGrantContains({ paths: ["~/docs"] }, { paths: ["~/docs/notes.md"] }),
    ).toBe(true);
  });

  it("rejects sibling directories", () => {
    expect(
      pathGrantContains({ paths: ["/tmp/a"] }, { paths: ["/tmp/b"] }),
    ).toBe(false);
    expect(
      pathGrantContains({ paths: ["./src"] }, { paths: ["./test"] }),
    ).toBe(false);
  });

  it("rejects parent directories of a granted root", () => {
    expect(
      pathGrantContains({ paths: ["./src"] }, { paths: ["./"] }),
    ).toBe(false);
    expect(
      pathGrantContains({ paths: ["/tmp/a/b"] }, { paths: ["/tmp/a"] }),
    ).toBe(false);
  });

  it("rejects prefix matches that are not path-segment boundaries", () => {
    expect(
      pathGrantContains({ paths: ["/tmp/a"] }, { paths: ["/tmp/ab"] }),
    ).toBe(false);
  });

  it("requires every subset path to fit under some superset path", () => {
    expect(
      pathGrantContains(
        { paths: ["/tmp/a", "/tmp/b"] },
        { paths: ["/tmp/a/x", "/tmp/b/y"] },
      ),
    ).toBe(true);
    expect(
      pathGrantContains(
        { paths: ["/tmp/a", "/tmp/b"] },
        { paths: ["/tmp/a/x", "/tmp/c"] },
      ),
    ).toBe(false);
  });
});

describe("pathGrantContains strict kind handling", () => {
  it("denies a kind absent from the superset row", () => {
    expect(
      pathGrantContains({ paths: ["/tmp"] }, { other: ["x"] }),
    ).toBe(false);
    expect(
      pathGrantContains({}, { paths: ["/tmp"] }),
    ).toBe(false);
  });

  it("defers non-paths kinds to defaultContains per value", () => {
    expect(
      pathGrantContains(
        { paths: ["/tmp"], other: ["a", "b"] },
        { paths: ["/tmp"], other: ["a"] },
      ),
    ).toBe(true);
    expect(
      pathGrantContains(
        { paths: ["/tmp"], other: ["a"] },
        { paths: ["/tmp"], other: ["b"] },
      ),
    ).toBe(false);
    expect(
      pathGrantContains(
        { paths: ["/tmp"], other: "*" },
        { paths: ["/tmp"], other: ["anything"] },
      ),
    ).toBe(true);
  });

  it("does not give non-paths kinds prefix semantics", () => {
    expect(
      pathGrantContains({ other: ["/tmp"] }, { other: ["/tmp/sub"] }),
    ).toBe(false);
  });
});

describe("pathGrantContains star cases", () => {
  it('"*" superset contains everything', () => {
    expect(pathGrantContains("*", "*")).toBe(true);
    expect(pathGrantContains("*", { paths: ["/anywhere"] })).toBe(true);
    expect(pathGrantContains("*", {})).toBe(true);
  });

  it('"*" subset is only contained by "*"', () => {
    expect(pathGrantContains({ paths: ["/tmp"] }, "*")).toBe(false);
    expect(pathGrantContains(undefined, "*")).toBe(false);
  });

  it('paths = "*" within a row contains any paths value', () => {
    expect(
      pathGrantContains({ paths: "*" }, { paths: ["/anywhere"] }),
    ).toBe(true);
    expect(
      pathGrantContains({ paths: ["/tmp"] }, { paths: "*" }),
    ).toBe(false);
  });
});

describe("pathGrantContains row sets", () => {
  it("fits each subset row into some single superset row", () => {
    const superset = [{ paths: ["/tmp/a"] }, { paths: ["/tmp/b"] }];
    expect(pathGrantContains(superset, { paths: ["/tmp/a/x"] })).toBe(true);
    expect(pathGrantContains(superset, { paths: ["/tmp/b"] })).toBe(true);
    expect(
      pathGrantContains(superset, [
        { paths: ["/tmp/a/x"] },
        { paths: ["/tmp/b/y"] },
      ]),
    ).toBe(true);
  });

  it("rejects a subset row spanning two superset rows", () => {
    const superset = [{ paths: ["/tmp/a"] }, { paths: ["/tmp/b"] }];
    expect(
      pathGrantContains(superset, { paths: ["/tmp/a/x", "/tmp/b/y"] }),
    ).toBe(false);
  });

  it("rejects when any subset row fits no superset row", () => {
    const superset = [{ paths: ["/tmp/a"] }];
    expect(
      pathGrantContains(superset, [{ paths: ["/tmp/a/x"] }, { paths: ["/tmp/c"] }]),
    ).toBe(false);
  });
});

describe("pathGrantContains undefined superset", () => {
  it("contains undefined and empty subsets only", () => {
    expect(pathGrantContains(undefined, undefined)).toBe(true);
    expect(pathGrantContains(undefined, {})).toBe(true);
    expect(pathGrantContains(undefined, [{}])).toBe(true);
    expect(pathGrantContains(undefined, { paths: ["/tmp"] })).toBe(false);
    expect(pathGrantContains(undefined, [{}, { paths: ["/tmp"] }])).toBe(false);
  });
});

describe("path-based builtins expose containsGrant", () => {
  const tools = [
    new ReadFileTool({}, { paths: ["/tmp/a"] }),
    new WriteFileTool({}, { paths: ["/tmp/a"] }),
    new EditFileTool({}, { paths: ["/tmp/a"] }),
    new FindTool({}, { paths: ["/tmp/a"] }),
  ];

  it.each(tools.map((t) => [t.name, t] as const))(
    "%s delegates to pathGrantContains",
    (_name, tool) => {
      expect(tool.containsGrant({ paths: ["./"] }, { paths: ["./src"] })).toBe(
        true,
      );
      expect(tool.containsGrant({ paths: ["./src"] }, { paths: ["./"] })).toBe(
        false,
      );
      expect(tool.containsGrant(undefined, {})).toBe(true);
      expect(tool.containsGrant("*", { paths: ["/anywhere"] })).toBe(true);
    },
  );
});
