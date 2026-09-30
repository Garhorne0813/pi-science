import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { CredentialStore } from "../../../model-resources/credential-store.js";
import { ModelResourceRepository } from "../../../model-resources/model-resource-repository.js";

/** Resolve the same managed provider credentials shown by Settings for Pi's built-in providers. */
export function agentModels() {
  const resources = new ModelResourceRepository();
  const credentials = new CredentialStore();
  const credentialFor = (providerId: string) => {
    const ref = resources.readSync().credential_refs[providerId];
    return ref ? credentials.readSync(ref)?.secret ?? undefined : undefined;
  };
  const models = builtinModels({ credentials: {
    async read(providerId) {
      const key = credentialFor(providerId);
      return key ? { type: "api_key" as const, key } : undefined;
    },
    async list() {
      return Object.keys(resources.readSync().credential_refs)
        .filter((providerId) => Boolean(credentialFor(providerId)))
        .map((providerId) => ({ providerId, type: "api_key" as const }));
    },
    async modify() { throw new Error("Managed credentials must be changed in Settings"); },
    async delete() { throw new Error("Managed credentials must be changed in Settings"); },
  } });
  return models;
}

/** The agent-core catalog is authoritative even before a session worker starts. */
export async function agentModelCatalog() {
  return (await agentModels().getAvailable()).map((model) => ({
    provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, thinkingLevelMap: model.thinkingLevelMap,
  }));
}
