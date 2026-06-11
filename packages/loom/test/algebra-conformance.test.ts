import { describe, it, expect } from "vitest";

import {
  checkGrantAlgebra,
  customAlgebraWithoutSampler,
} from "../src/manifest/algebra-conformance.js";
import { BashTool } from "../src/runtime/builtins/bash.js";
import { ReadFileTool } from "../src/runtime/builtins/read_file.js";
import { buildNativeTools } from "../src/builtins/tools/native.js";
import { defined } from "./helpers/assert.js";
import type { Agent, Tool } from "../src/types/interfaces.js";
import type { CapabilitySet } from "../src/types/manifest.js";

describe("capability algebra conformance", () => {
  // Bash is the most security-critical tool and has the richest value space
  // (commands enum/"*", network on/off, nested path prefixes, env allowlists,
  // and row sets of 1–4). Hammer it across many independent seeds so a law
  // that only breaks on a rare row-set shape can't hide behind one lucky seed.
  it("the bash tool's algebra obeys the lattice laws (via its own sampleGrant)", () => {
    const tool = new BashTool({}, { commands: "*" });
    for (let seed = 1; seed <= 12; seed++) {
      const violations = checkGrantAlgebra(tool, {
        samples: 80,
        trials: 1500,
        seed,
      });
      expect(violations, `seed ${seed}: ${JSON.stringify(violations)}`).toEqual(
        [],
      );
    }
  });

  // The path builtins override containsGrant with lexical prefix containment
  // and supply samplePathGrant so the checker draws nested prefixes (./ ⊃
  // ./src) the generic generator never would. Hammer it across seeds too.
  it("the path builtins' algebra obeys the lattice laws (via samplePathGrant)", () => {
    const tool = new ReadFileTool({}, { paths: ["./"] });
    for (let seed = 1; seed <= 8; seed++) {
      const violations = checkGrantAlgebra(tool, {
        samples: 80,
        trials: 1500,
        seed,
      });
      expect(violations, `seed ${seed}: ${JSON.stringify(violations)}`).toEqual(
        [],
      );
    }
  });

  it("the default algebra obeys the laws (generic fallback, no tool hooks)", () => {
    // No containsGrant / mergeGrants / sampleGrant → exercises the defaults
    // over generic structural grants built from the declared kinds.
    const tool = { requires: ["paths"], optional: ["network", "env"] };
    const violations = checkGrantAlgebra(tool, {
      samples: 96,
      trials: 2000,
      seed: 3,
    });
    expect(violations).toEqual([]);
  });

  // The checker is only useful if it actually fails on a broken algebra —
  // otherwise "all green" tells us nothing (the same trap as testing only the
  // happy path of admission).
  it("catches a merge that isn't an upper bound", () => {
    const broken = {
      requires: ["paths"],
      // Drops everything — merge(a,b) won't contain its inputs.
      mergeGrants: (
        _a: CapabilitySet,
        _b: CapabilitySet,
      ): CapabilitySet => ({}),
    };
    const violations = checkGrantAlgebra(broken, { samples: 40, trials: 300 });
    expect(violations.some((v) => v.law === "merge-upper-bound")).toBe(true);
  });

  it("catches a non-reflexive containment", () => {
    const broken = {
      requires: ["paths"],
      containsGrant: (): boolean => false,
    };
    const violations = checkGrantAlgebra(broken, { samples: 20, trials: 50 });
    expect(violations.some((v) => v.law === "reflexivity")).toBe(true);
  });

  // The subtle one: a merge that flattens a row set into a single kind-wise
  // box. It still contains both inputs (passes the upper-bound guard), but
  // fabricates a coupling neither input granted. Only the least-upper-bound
  // law catches it.
  it("catches a flattening merge that the upper-bound guard cannot", () => {
    const flattenRow = (g: CapabilitySet): Record<string, unknown> => {
      if (g === "*") return {};
      const rows = Array.isArray(g) ? g : [g];
      return Object.assign({}, ...rows) as Record<string, unknown>;
    };
    const flatten = {
      requires: ["commands"],
      optional: ["network", "paths"],
      // Collapses both inputs' rows into one box — loses the disjunction.
      mergeGrants: (a: CapabilitySet, b: CapabilitySet): CapabilitySet =>
        ({ ...flattenRow(a), ...flattenRow(b) }) as CapabilitySet,
    };
    const violations = checkGrantAlgebra(flatten, {
      samples: 64,
      trials: 1500,
      seed: 11,
    });
    expect(violations.some((v) => v.law === "merge-least-upper-bound")).toBe(
      true,
    );
  });

  // Coverage hygiene (audit warning, not a hard failure): a tool that overrides
  // the algebra but ships no sampleGrant is only ever checked with generic
  // grants, so domain shapes go unexercised.
  it("flags a custom algebra that omits sampleGrant", () => {
    const customNoSampler = {
      requires: ["commands"],
      containsGrant: (): boolean => true,
    };
    expect(customAlgebraWithoutSampler(customNoSampler)).toBe(true);

    const customWithSampler = {
      requires: ["commands"],
      mergeGrants: (a: CapabilitySet): CapabilitySet => a,
      sampleGrant: (): CapabilitySet => ({}),
    };
    expect(customAlgebraWithoutSampler(customWithSampler)).toBe(false);

    // Default algebra (no overrides) needs no sampler: the proven defaults
    // plus the generic generator are enough.
    expect(customAlgebraWithoutSampler({})).toBe(false);

    // Bash overrides the algebra but supplies its own sampler.
    const bash = new BashTool({}, { commands: "*" });
    expect(customAlgebraWithoutSampler(bash)).toBe(false);
  });

  // Regression: a renamed instance (e.g. the json-wrangler skill's `jq`,
  // backed by the bash builtin via `tool = "bash"`) must keep the underlying
  // tool's sampleGrant. renameTool used to forward containsGrant/mergeGrants
  // but drop sampleGrant, so the renamed instance silently fell back to the
  // generic generator and tripped the audit warning.
  it("a renamed instance keeps the underlying tool's sampleGrant", () => {
    const jq = defined(
      buildNativeTools().resolveTool("jq", { tool: "bash" }, {} as Agent, {
        commands: ["jq"],
        paths: ["./"],
      }) as Tool | null,
    );
    expect(customAlgebraWithoutSampler(jq)).toBe(false);
    expect(
      checkGrantAlgebra(jq, { samples: 60, trials: 1000, seed: 5 }),
    ).toEqual([]);
  });
});
