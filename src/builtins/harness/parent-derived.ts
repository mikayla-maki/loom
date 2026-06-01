import { ResolutionError } from "../../errors.js";
import type {
  Agent,
  FactoryContext,
  Harness,
  HarnessFactory,
} from "../../types/interfaces.js";

interface SmallModelOfParentConfig {
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
      throw new ResolutionError(
        "small-model-of-parent harness was instantiated without a parent agent",
      );
    }
    if (typeof parent.harness.withModel !== "function") {
      throw new ResolutionError(
        `small-model-of-parent harness requires the parent harness to implement the optional ` +
          `withModel(modelId) method. ${parent.harness.constructor.name} doesn't — ` +
          `add the method to support being used as a parent of this factory.`,
      );
    }
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
