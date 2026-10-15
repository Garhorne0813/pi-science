import { ModelConfigService } from "../../model-config/model-config-service.js";

/** Aliases are explicit native identity mappings, never runtime legacy reads. */
export function canonicalRuntimeModelRef(model: string): string {
  return new ModelConfigService().readSync().aliases[model] ?? model;
}
