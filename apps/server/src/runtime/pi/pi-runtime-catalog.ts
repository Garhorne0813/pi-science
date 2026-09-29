/** Model catalog for the Pi runtime.
 *
 *  The catalog is read from the same pi-ai model runtime the agent runs on, so
 *  the app and the runtime cannot disagree about providers, models, or thinking
 *  levels. It used to be fetched from a separate Pi Orbit web host process
 *  (GET /api/catalog); reading the runtime's own catalog removes that host from
 *  the architecture and keeps the catalog correct across runtime upgrades.
 */
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { configRoot } from "../../storage/persistence.js";
import { ModelResourceRepository } from "../../model-resources/model-resource-repository.js";
import { loadDefaultPiConfig, materializeApiKeysAuth, materializeRuntimeSettings, readPiSettings } from "./pi-runtime-launch.js";
import { projectPiRuntime } from "./pi-runtime-projection.js";

export type PiRuntimeCatalogModel = {
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  thinkingLevels?: string[];
  input: string[];
  contextWindow: number;
  maxTokens: number;
};

export type PiRuntimeCatalogProvider = {
  id: string;
  name: string;
  baseUrl: string | null;
  auth: { apiKey: boolean; oauth: boolean; subscription: boolean; configured: boolean };
  models: PiRuntimeCatalogModel[];
};

export type PiRuntimeCatalog = { schemaVersion: 1; providers: PiRuntimeCatalogProvider[] };

export class PiRuntimeCatalogError extends Error {
  readonly code: "runtime_catalog_unavailable" | "runtime_catalog_incompatible";

  constructor(code: PiRuntimeCatalogError["code"], message: string) {
    super(message);
    this.name = "PiRuntimeCatalogError";
    this.code = code;
  }
}

function canonicalProviderIds(): string[] {
  try {
    return new ModelResourceRepository().readSync().providers
      .filter((provider) => provider.kind === "user")
      .map((provider) => provider.id);
  } catch {
    return [];
  }
}

/**
 * The runtime projection may split one canonical user provider into multiple
 * runtime providers (`user-lab--ep-a`, `user-lab--ep-b`) because Pi providers
 * each carry one base URL. Those route-local entries are an implementation
 * detail: canonical model-resource providers are exposed separately by the
 * control plane, so remove their projected runtime aliases from this catalog
 * instead of duplicating them as apparent system providers.
 */
export function withoutProjectedUserProviders(catalog: PiRuntimeCatalog, canonicalIds: readonly string[]): PiRuntimeCatalog {
  if (!canonicalIds.length) return catalog;
  const projected = (providerId: string) => canonicalIds.some((id) => providerId === id || providerId.startsWith(`${id}--`));
  return { schemaVersion: 1, providers: catalog.providers.filter((provider) => !projected(provider.id)) };
}

/** The catalog must see the same custom providers (models.json) and stored API
 *  keys (auth.json) as a runtime, otherwise it reports different providers as
 *  configured. Credential env vars are set on this process because the model
 *  runtime resolves `$VAR` apiKey references from the environment. */
function prepareCatalogAgentDir(): string {
  const dataRoot = configRoot();
  const agentDir = join(dataRoot, "pi-agent", "catalog");
  mkdirSync(agentDir, { recursive: true });
  const projection = projectPiRuntime(agentDir, dataRoot, process.env);
  for (const [name, secret] of Object.entries(projection.runtimeSecrets)) process.env[name] = secret;
  const settings = readPiSettings(dataRoot);
  const storedKeys = settings.api_keys && typeof settings.api_keys === "object" ? settings.api_keys as Record<string, unknown> : {};
  materializeApiKeysAuth(agentDir, { ...storedKeys, ...projection.systemApiKeys });
  materializeRuntimeSettings(agentDir, settings, loadDefaultPiConfig());
  return agentDir;
}

async function createCatalogRuntime(): Promise<ModelRuntime> {
  const agentDir = prepareCatalogAgentDir();
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  });
}

export class PiRuntimeCatalogService {
  private pending: Promise<PiRuntimeCatalog> | undefined;
  private runtime: Promise<ModelRuntime> | undefined;

  constructor(
    private readonly runtimeFactory: () => Promise<ModelRuntime> = createCatalogRuntime,
    private readonly canonicalProviderIdsFactory: () => readonly string[] = canonicalProviderIds,
  ) {}

  async getCatalog(): Promise<PiRuntimeCatalog> {
    if (this.pending) return this.pending;
    const pending = this.load();
    this.pending = pending;
    try { return await pending; }
    finally { if (this.pending === pending) this.pending = undefined; }
  }

  private runtimeInstance(): Promise<ModelRuntime> {
    if (!this.runtime) {
      const created = this.runtimeFactory();
      this.runtime = created;
      created.catch(() => { if (this.runtime === created) this.runtime = undefined; });
    }
    return this.runtime;
  }

  private async load(): Promise<PiRuntimeCatalog> {
    let runtime: ModelRuntime;
    try {
      runtime = await this.runtimeInstance();
    } catch (error) {
      throw new PiRuntimeCatalogError(
        "runtime_catalog_unavailable",
        `Pi runtime catalog is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const providers: PiRuntimeCatalogProvider[] = runtime.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl ?? null,
      auth: {
        apiKey: provider.auth.apiKey !== undefined,
        oauth: provider.auth.oauth !== undefined,
        subscription: provider.auth.oauth?.isSubscription === true,
        configured: runtime.hasConfiguredAuth(provider.id),
      },
      models: runtime.getModels(provider.id).map((model: Model<Api>) => ({
        id: model.id,
        name: model.name,
        api: model.api,
        reasoning: model.reasoning,
        thinkingLevels: getSupportedThinkingLevels(model),
        input: [...model.input],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    }));
    return withoutProjectedUserProviders({ schemaVersion: 1, providers }, this.canonicalProviderIdsFactory());
  }
}
