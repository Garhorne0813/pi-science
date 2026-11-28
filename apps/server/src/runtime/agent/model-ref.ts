import { ModelConfigService } from "../../model-config/model-config-service.js";

/** Model IDs retired by an upstream catalog rename, mapped to their current
 * successor. Persisted sessions keep the ID they were created with, so a
 * catalog update must not make those sessions unusable. Explicit user aliases
 * still take precedence over this compatibility table. */
const LEGACY_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "deepseek/deepseek-v4-flash": "deepseek/deepseek-flash",
};

/** Aliases are explicit native identity mappings, never runtime legacy reads. */
export function canonicalRuntimeModelRef(model: string): string {
  return new ModelConfigService().readSync().aliases[model] ?? LEGACY_MODEL_ALIASES[model] ?? model;
}
