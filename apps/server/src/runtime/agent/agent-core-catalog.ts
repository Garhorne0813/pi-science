import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { RuntimeCatalog } from "../agent/runtime-catalog.js";
import { agentModels } from "./worker/agent-models.js";

/** Provider inventory and model validation must use the active runtime's catalog. */
export class AgentCoreCatalogService {
  async getCatalog(): Promise<RuntimeCatalog> {
    const models = agentModels();
    const configured = new Set((await models.getAvailable()).map((model) => model.provider));
    return {
      schemaVersion: 1,
      providers: models.getProviders().filter((provider) => !provider.id.startsWith("user-")).map((provider) => ({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl ?? null,
        auth: {
          apiKey: Boolean(provider.auth.apiKey),
          oauth: Boolean(provider.auth.oauth),
          subscription: Boolean(provider.auth.oauth && !provider.auth.apiKey),
          configured: configured.has(provider.id),
        },
        models: provider.getModels().map((model) => ({
          id: model.id,
          name: model.name,
          api: model.api,
          reasoning: model.reasoning,
          thinkingLevels: getSupportedThinkingLevels(model),
          input: [...model.input],
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        })),
      })),
    };
  }
}
