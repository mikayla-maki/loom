/**
 * Parent-derived harness factories.
 *
 * These run only as sub-agents — they read state from the parent's
 * `Agent` (its harness in particular) and build a sibling. Top-level
 * use fails at boot via the `requiresParent: true` guard in
 * `runAgent`.
 *
 * Currently shipped:
 *   - `small-model-of-parent`: clones the parent's harness with a
 *     different model id. Works with any harness that implements the
 *     optional `Harness.withModel(modelId)` method.
 *
 * To support a new derivation shape, add the corresponding optional
 * method to the `Harness` interface (e.g. `withTemperature`), have
 * the harness classes implement it, and wire a factory here that
 * dispatches through the method.
 */

import { ResolutionError } from "../../errors.js";
import type {
  Agent,
  FactoryContext,
  Harness,
  HarnessFactory,
} from "../../types/interfaces.js";

interface SmallModelOfParentConfig {
  /**
   * Model id to route to. Optional: if omitted, the factory falls
   * back to the parent harness's `smallModel()` recommendation. The
   * harness must implement either `smallModel()` or accept an
   * explicit `model` config (or both).
   */
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
    // Dispatch through the optional `Harness.withModel` API. Any
    // harness that implements it (Anthropic, OpenAI, and any
    // third-party harness following the same convention) works
    // without a special case here.
    if (typeof parent.harness.withModel !== "function") {
      throw new ResolutionError(
        `small-model-of-parent harness requires the parent harness to implement the optional ` +
          `withModel(modelId) method. ${parent.harness.constructor.name} doesn't — ` +
          `add the method to support being used as a parent of this factory.`,
      );
    }
    // Resolve the model id: explicit config wins; otherwise the
    // parent harness's `smallModel()` recommendation is used.
    const c = config as SmallModelOfParentConfig;
    const model = c.model ?? parent.harness.smallModel?.();
    if (!model) {
      throw new ResolutionError(
        `small-model-of-parent harness needs a model id. Either pass \`model = "..."\` ` +
          `in the [harness] block, or use a parent harness that implements the optional ` +
          `smallModel() method (${parent.harness.constructor.name} doesn't).`,
      );
    }
    return parent.harness.withModel(model);
  },
};
