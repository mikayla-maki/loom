/**
 * Parent-derived harness factories.
 *
 * These run only as sub-agents — they read state from the parent's
 * `Agent` (its harness in particular) and build a sibling. Top-level
 * use fails at boot via the `requiresParent: true` guard in
 * `runAgent`.
 *
 * Currently shipped:
 *   - `small-model-of-parent`: clones the parent's `AnthropicHarness`
 *     with a different model id (cheaper / faster routing).
 *
 * Each such factory is a tiny adapter; the heavy lifting (actually
 * cloning the harness) lives on the harness class as a `withModel`
 * (or analogous) method. New parent-derived shapes should follow the
 * same pattern: factory + harness method.
 */

import { AnthropicHarness } from "./anthropic.js";
import { ResolutionError } from "../../errors.js";
import type {
  Agent,
  FactoryContext,
  Harness,
  HarnessFactory,
} from "../../types/interfaces.js";

interface SmallModelOfParentConfig {
  /** Model id to route to. Required. */
  model?: string;
}

export const smallModelOfParentHarnessFactory: HarnessFactory = {
  name: "small-model-of-parent",
  requiresParent: true,
  create(
    config: Record<string, unknown>,
    _ctx: FactoryContext,
    _secrets: Record<string, string>,
    parent?: Agent,
  ): Harness {
    if (!parent) {
      // The boot guard in runAgent should fire first; this is a
      // defensive check for direct callers (tests, SDK consumers).
      throw new ResolutionError(
        "small-model-of-parent harness was instantiated without a parent agent",
      );
    }
    const c = config as SmallModelOfParentConfig;
    if (!c.model) {
      throw new ResolutionError(
        "small-model-of-parent harness requires a `model` field naming the smaller model id",
      );
    }
    if (!(parent.harness instanceof AnthropicHarness)) {
      throw new ResolutionError(
        `small-model-of-parent harness requires the parent to use AnthropicHarness; got ${parent.harness.constructor.name}. (To support other providers, add a withModel() method on the harness class.)`,
      );
    }
    return parent.harness.withModel(c.model);
  },
};
