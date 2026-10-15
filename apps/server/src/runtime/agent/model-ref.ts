import { ModelConfigService, modelConfigBackend } from "../../model-config/model-config-service.js";
import { ModelResourceRepository } from "../../model-resources/model-resource-repository.js";

/** Resolve persisted model aliases into the canonical identity used by Core. */
export function canonicalRuntimeModelRef(model: string): string {
  if (modelConfigBackend() === "pi_ai_v1") return new ModelConfigService().readSync().aliases[model] ?? model;
  return new ModelResourceRepository().readSync().aliases[model] ?? model;
}
