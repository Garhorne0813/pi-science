import { ModelResourceRepository } from "../../model-resources/model-resource-repository.js";

/** Resolve persisted model aliases into the canonical identity used by Core. */
export function canonicalRuntimeModelRef(model: string): string {
  return new ModelResourceRepository().readSync().aliases[model] ?? model;
}
