import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type PiAiProviderCatalogEntry = {
  id: string;
  name: string;
  apiKeySupported: boolean;
  oauthSupported: boolean;
  subscription: boolean;
  modelIds: string[];
};

function piAiDistCandidates(): string[] {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const candidates: string[] = [];
  try { candidates.push(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")))); }
  catch { /* packaged server dependency is unavailable; try the legacy runtime layout */ }
  candidates.push(join(projectRoot, "runtime", "pi", "node_modules", "@earendil-works", "pi-ai", "dist"));
  return [...new Set(candidates)];
}

function piAiModules(): { providersModule: string; envKeysModule: string } | null {
  for (const dist of piAiDistCandidates()) {
    const providersModule = join(dist, "providers", "all.js");
    const envKeysModule = join(dist, "env-api-keys.js");
    if (existsSync(providersModule) && existsSync(envKeysModule)) return { providersModule, envKeysModule };
  }
  return null;
}

/** Load the provider catalog from the server-owned, pinned pi-ai package. The
 * runtime/pi path remains a fallback for older installations. */
export async function loadPiAiProviderCatalog(): Promise<PiAiProviderCatalogEntry[]> {
  const modules = piAiModules();
  if (!modules) return [];
  try {
    const { builtinProviders } = await import(pathToFileURL(modules.providersModule).href);
    const providers = typeof builtinProviders === "function" ? builtinProviders() : [];
    const result: PiAiProviderCatalogEntry[] = [];
    for (const provider of providers) {
      if (!provider || typeof provider !== "object") continue;
      const candidate = provider as {
        id?: unknown; name?: unknown; auth?: { apiKey?: unknown; oauth?: { isSubscription?: unknown } }; getModels?: () => unknown;
      };
      const id = String(candidate.id ?? "");
      if (!id) continue;
      const auth = candidate.auth;
      const apiKeySupported = Boolean(auth?.apiKey);
      const oauthSupported = Boolean(auth?.oauth);
      // Older pi-ai releases exposed `isSubscription`; newer lazy OAuth
      // descriptors omit it. An OAuth-only provider is still a subscription
      // login surface when the runtime does not expose the optional flag.
      const subscription = Boolean(
        auth?.oauth
        && ((auth.oauth as { isSubscription?: unknown }).isSubscription === true || !apiKeySupported),
      );
      let modelIds: string[] = [];
      try {
        const models = typeof candidate.getModels === "function" ? candidate.getModels() : [];
        if (Array.isArray(models)) {
          modelIds = models
            .map((entry) => {
              if (typeof entry === "string") return entry;
              if (entry && typeof entry === "object") return String((entry as { id?: unknown }).id ?? "");
              return "";
            })
            .filter(Boolean);
        }
      } catch { /* provider without a synchronous model listing */ }
      result.push({ id, name: String(candidate.name ?? id), apiKeySupported, oauthSupported, subscription, modelIds });
    }
    return result;
  } catch {
    return [];
  }
}

/** Boolean environment credential check for a pi-ai provider id (api-key only
 *  providers; OAuth tokens are never stored in the process environment by
 *  Pi-Science). Never leaks the key value. */
export async function hasEnvApiKey(providerId: string): Promise<boolean> {
  const modules = piAiModules();
  if (!modules) return false;
  try {
    const { getEnvApiKey } = await import(pathToFileURL(modules.envKeysModule).href) as { getEnvApiKey?: (provider: string, env: NodeJS.ProcessEnv) => string | undefined };
    if (typeof getEnvApiKey !== "function") return false;
    const value = getEnvApiKey(providerId, process.env);
    return typeof value === "string" && value.length > 0;
  } catch {
    return false;
  }
}
