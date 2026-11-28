import { z } from "zod";
import { CredentialStore } from "../model-resources/credential-store.js";
import { configPath, writeJsonAtomic } from "../storage/persistence.js";
import { SettingsStore, type SettingsData } from "../storage/settings-store.js";

export const webProviders = [
  "auto",
  "exa",
  "brave",
  "tavily",
  "perplexity",
  "jina",
  "deepseek",
] as const;
const keyNames = z.enum(["exa", "brave", "tavily", "perplexity", "jina", "deepseek"]);
const apiKeys = z.partialRecord(keyNames, z.string().trim().max(4096));
export const webSettingsPatchSchema = z
  .object({
    search_enabled: z.boolean().optional(),
    fetch_enabled: z.boolean().optional(),
    provider: z.enum(webProviders).optional(),
    api_keys: apiKeys.optional(),
  })
  .strict();
export const webSettingsSchema = z
  .object({
    search_enabled: z.boolean().default(true),
    fetch_enabled: z.boolean().default(true),
    provider: z.enum(webProviders).default("auto"),
    credential_refs: z.partialRecord(keyNames, z.string().min(1)).default({}),
  })
  .strict();
type StoredWebSettings = z.infer<typeof webSettingsSchema>;
export type WebSettings = Omit<StoredWebSettings, "credential_refs"> & {
  api_keys: z.infer<typeof apiKeys>;
};
const credentials = new CredentialStore();

export async function webSettingsFromConfig(config: SettingsData): Promise<WebSettings> {
  if (config.web_access !== undefined) {
    const { credential_refs, ...settings } = webSettingsSchema.parse(config.web_access);
    const keys: WebSettings["api_keys"] = {};
    for (const [name, ref] of Object.entries(credential_refs)) {
      const value = await credentials.getForRuntime(ref!);
      if (value?.secret) keys[name as keyof typeof keys] = value.secret;
    }
    return { ...settings, api_keys: keys };
  }
  return { search_enabled: true, fetch_enabled: true, provider: "auto", api_keys: {} };
}

/** Raw keys are accepted only at the HTTP boundary. Ordinary configuration
 * holds references to the existing managed credential store. */
export async function updateWebSettings(
  config: SettingsData,
  patch: z.infer<typeof webSettingsPatchSchema>,
): Promise<WebSettings> {
  const previous = await webSettingsFromConfig(config);
  const stored = webSettingsSchema.parse(config.web_access ?? {});
  const keys = { ...previous.api_keys, ...patch.api_keys };
  for (const name of Object.keys(keys) as Array<keyof typeof keys>) {
    const key = keys[name];
    if (key && (!stored.credential_refs[name] || patch.api_keys?.[name] !== undefined)) {
      const entry = await credentials.put({
        id: stored.credential_refs[name],
        kind: "api_key",
        backend: "managed",
        label: `Web search: ${name}`,
        secret: key,
      });
      stored.credential_refs[name] = entry.id;
    } else if (!key) {
      const ref = stored.credential_refs[name];
      if (ref && (await credentials.metadata(ref))?.label === `Web search: ${name}`)
        await credentials.remove(ref);
      delete stored.credential_refs[name];
    }
  }
  const { api_keys: _keys, ...switches } = patch;
  const next = {
    ...stored,
    search_enabled: previous.search_enabled,
    fetch_enabled: previous.fetch_enabled,
    provider: previous.provider,
    ...switches,
  };
  config.web_access = next;
  return {
    search_enabled: next.search_enabled,
    fetch_enabled: next.fetch_enabled,
    provider: next.provider,
    api_keys: keys,
  };
}

export async function readWebSettings(): Promise<WebSettings> {
  return webSettingsFromConfig(await new SettingsStore().read());
}

export function publicWebSettings(settings: WebSettings) {
  return {
    ...settings,
    api_keys: Object.fromEntries(
      Object.entries(settings.api_keys).map(([name, key]) => [name, Boolean(key)]),
    ),
  };
}

/** Keep existing operator provider options, but never inherit another Pi agent's
 * configuration, browser cookies, clone commands or SSRF exceptions. */
export async function prepareNativeWebConfig(settings: WebSettings): Promise<string> {
  const directory = configPath("web/runtime");
  await writeJsonAtomic(
    `${directory}/web-search.json`,
    {
      provider: settings.provider === "deepseek" ? "auto" : settings.provider,
      ...Object.fromEntries(
        webProviders
          .filter((name) => name !== "auto" && name !== "deepseek")
          .map((name) => [`${name}ApiKey`, settings.api_keys[name] ?? ""]),
      ),
      githubClone: { enabled: false },
      githubPrIssue: { enabled: false },
      allowBrowserCookies: false,
      youtube: { enabled: false },
      ssrf: { allowRanges: [], trustEnvProxy: false },
      fetch: { defaultMode: "readable", allowedModes: ["readable", "raw"] },
      tools: {
        webSearch: { enabled: settings.search_enabled },
        fetchContent: { enabled: settings.fetch_enabled },
        getSearchContent: { enabled: true },
        sourceCheck: { enabled: false },
      },
    },
    { mode: 0o600 },
  );
  return directory;
}
