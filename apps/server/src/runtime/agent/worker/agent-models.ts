import { ModelConfigService, modelConfigBackend } from "../../../model-config/model-config-service.js";
import { ModelRegistryService } from "../../../model-config/model-registry-service.js";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { resolveContextWindow, type RuntimeSettings } from "../agent-runtime-settings.js";

/** All callers use the native snapshot; old resource files never participate. */
export function agentModels(settings: RuntimeSettings = {}) {
  modelConfigBackend();
  const service = new ModelConfigService();
  const models = new ModelRegistryService(service).compile(settings.modelConfigSnapshot ?? service.readSync(), settings.modelConfigAllowPrivate);
  for (const provider of models.getProviders()) {
    const catalog = provider.getModels().map((model) => ({ ...model, contextWindow: resolveContextWindow(`${model.provider}/${model.id}`, model.contextWindow, settings) }));
    models.setProvider({ ...provider, getModels: () => catalog });
  }
  return models;
}

/** The agent-core catalog is authoritative even before a session worker starts. */
export async function agentModelCatalog(models = agentModels()) {
  return (await models.getAvailable()).map((model) => ({
    provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, thinkingLevelMap: model.thinkingLevelMap,
    thinking_levels: getSupportedThinkingLevels(model), input: model.input,
  }));
}
