import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ModelResourceState, type ResolvedRuntimeProvider } from "@pi-science/contracts";
import { CredentialStore } from "../../model-resources/credential-store.js";
import { ModelResourceRepository } from "../../model-resources/model-resource-repository.js";
import { projectLegacyCustomProviders } from "../../model-resources/runtime-legacy-compat.js";
import { RuntimeModelResolver } from "../../model-resources/runtime-model-resolver.js";
import { runtimeCredentialEnvName } from "../../model-resources/runtime-credential-env.js";

export type PiRuntimeProjectionResult = {
  providers: Record<string, unknown>;
  runtimeSecrets: Record<string, string>;
  systemApiKeys: Record<string, string>;
};

function runtimeApi(protocol: string, api?: string): string {
  if (api) return api;
  if (protocol === "anthropic") return "anthropic-messages";
  if (protocol === "ollama") return "ollama";
  if (protocol === "native") return "native";
  return "openai-completions";
}

function readSettings(dataRoot: string): Record<string, unknown> {
  try { return JSON.parse(readFileSync(join(dataRoot, "config.json"), "utf8")) as Record<string, unknown>; }
  catch { return {}; }
}

function modelDefinition(model: { model_id: string; display_name: string; capabilities: { reasoning: boolean; thinking_levels: string[]; context_window: number | null; max_output_tokens: number | null; vision?: boolean; tools?: boolean; structured_output?: boolean } }): Record<string, unknown> {
  const capabilities = model.capabilities;
  return {
    id: model.model_id,
    name: model.display_name,
    input: ["text", ...(capabilities.vision ? ["image"] : [])],
    reasoning: capabilities.reasoning,
    ...(capabilities.context_window ? { contextWindow: capabilities.context_window } : {}),
    ...(capabilities.max_output_tokens ? { maxTokens: capabilities.max_output_tokens } : {}),
    ...(capabilities.reasoning ? { thinkingLevelMap: Object.fromEntries(capabilities.thinking_levels.map((level) => [level, level])) } : {}),
  };
}

function projectionFromState(state: ModelResourceState, credentials: CredentialStore): PiRuntimeProjectionResult {
  const resolver = new RuntimeModelResolver(new ModelResourceRepository(), credentials);
  const resolved = resolver.resolveStateSync(state).filter((model) => model.available);
  const providers: Record<string, Record<string, unknown>> = {};
  const runtimeSecrets: Record<string, string> = {};
  for (const provider of state.providers.filter((item) => item.enabled && item.kind === "user")) {
    const models = resolved.filter((model) => model.provider_id === provider.id);
    if (models.length === 0) continue;
    const firstRoute = models.flatMap((model) => model.routes).sort((a, b) => a.priority - b.priority || a.binding_id.localeCompare(b.binding_id))[0];
    if (!firstRoute) continue;
    const projected: Record<string, unknown> = {
      name: provider.name,
      baseUrl: firstRoute.base_url,
      api: runtimeApi(firstRoute.protocol, firstRoute.api),
      models: models.map(modelDefinition),
    };
    if (firstRoute.credential_ref) {
      const credential = credentials.readSync(firstRoute.credential_ref);
      if (credential?.secret) {
        const variable = runtimeCredentialEnvName(firstRoute.credential_ref);
        runtimeSecrets[variable] = credential.secret;
        projected.apiKey = `$${variable}`;
      }
    }
    providers[provider.id] = projected;
  }
  const systemApiKeys: Record<string, string> = {};
  for (const [providerId, credentialRef] of Object.entries(state.credential_refs)) {
    const credential = credentials.readSync(credentialRef);
    if (credential?.secret) systemApiKeys[providerId] = credential.secret;
  }
  return { providers, runtimeSecrets, systemApiKeys };
}

/** Build and write the only Pi-specific model catalog. Domain resources remain
 * independent of this generated artifact. */
export function projectPiRuntime(agentDir: string, dataRoot: string, env: NodeJS.ProcessEnv): PiRuntimeProjectionResult {
  const repository = new ModelResourceRepository();
  const credentials = new CredentialStore();
  const settings = readSettings(dataRoot);
  const state = repository.readSync();
  let result = projectionFromState(state, credentials);
  // Existing installations can start before the async migration has been
  // triggered by the control-plane API. Read the old shape only through the
  // isolated compatibility adapter and never persist it back.
  if (Object.keys(result.providers).length === 0 && !state.migration) {
    const legacy = projectLegacyCustomProviders(settings);
    result = { ...result, providers: legacy.providers, runtimeSecrets: { ...result.runtimeSecrets, ...legacy.runtimeSecrets } };
  }
  for (const [key, value] of Object.entries(result.runtimeSecrets)) env[key] = value;
  const path = join(agentDir, "models.json");
  if (Object.keys(result.providers).length === 0) {
    try { unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } else {
    writeFileSync(path, `${JSON.stringify({ providers: result.providers }, null, 2)}\n`, "utf8");
    try { chmodSync(path, 0o600); } catch { /* permissions are best-effort */ }
  }
  return result;
}

export function canonicalRuntimeModelRef(model: string): string {
  const state = new ModelResourceRepository().readSync();
  return state.aliases[model] ?? model;
}

export function projectionProvidersFromResolved(resolved: ResolvedRuntimeProvider[]): Record<string, unknown> {
  return Object.fromEntries(resolved.map((provider) => [provider.runtime_provider_id, provider]));
}

export function isProjectionArtifact(path: string): boolean {
  return existsSync(path) && path.endsWith("models.json");
}
