import { applySessionReplacements, type SessionReplacement } from "./runtime-store";
import { apiRequest } from "./api";
import { queryClient } from "./query-client";

export const settingsKey = (...selector: Array<string | null>) => ["settings", ...selector];

type SettingsEnvelope = { ok?: boolean; error?: string; detail?: string; session_replacements?: SessionReplacement[] };

/** Settings routes answer HTTP 200 with `{ ok: false, error }` as well as real HTTP errors,
 *  so the envelope needs its own check on top of the transport's. One implementation for
 *  both the parsed and the raw-Response form; `error` wins over `detail` here (pinned by test). */
function unwrapSettings<T>(data: T & SettingsEnvelope, fallback: string): T {
  if (data.ok === false) throw new Error(data.error || data.detail || fallback);
  if (Array.isArray(data.session_replacements)) applySessionReplacements(data.session_replacements);
  return data;
}

/** Raw-Response variant for the settings page's own `fetch` call sites (A6 migrates those). */
export async function readSettingsResponse<T>(response: Response, fallback: string): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & SettingsEnvelope;
  if (!response.ok) throw new Error(data.error || data.detail || fallback);
  return unwrapSettings(data, fallback);
}

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** Config is read often and changes rarely — it kept a 3s TTL, now the client default. */
const configQuery = <T,>(cwd?: string | null) => ({
  queryKey: settingsKey("config", cwd ?? null),
  queryFn: () => apiRequest<T & SettingsEnvelope>(`/api/settings/config${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`),
});

export const settingsApi = {
  async config<T>(cwd?: string | null): Promise<T> {
    // The replacement side effect runs on every call, cached or not, as it did before.
    const data = await queryClient.fetchQuery(configQuery<T>(cwd)) as T & SettingsEnvelope;
    return unwrapSettings(data, "Unable to load settings");
  },

  /** Skill enablement lives under settings but was never cached; keep it uncached. */
  skills<T>(): Promise<T> {
    return queryClient.fetchQuery({ queryKey: settingsKey("skills"), queryFn: () => apiRequest<T>("/api/settings/skills"), staleTime: 0 });
  },

  async saveApiKey(provider: string, apiKey: string): Promise<void> {
    unwrapSettings(await apiRequest<SettingsEnvelope>("/api/settings/api-key", json("PUT", { provider, api_key: apiKey })), "Unable to save API key");
    invalidateSettings();
  },

  async deleteApiKey(provider: string): Promise<void> {
    unwrapSettings(await apiRequest<SettingsEnvelope>(`/api/settings/api-key/${encodeURIComponent(provider)}`, { method: "DELETE" }), "Unable to delete API key");
    invalidateSettings();
  },

  async saveModel<T>(model: string, thinking: string, cwd?: string | null): Promise<T> {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const result = unwrapSettings(await apiRequest<T & SettingsEnvelope>(`/api/settings/model${query}`, json("PUT", { model, thinking })), "Unable to save default model");
    invalidateSettings();
    return result;
  },

  async saveCompaction<T>(enabled: boolean, thresholdPercent: number, cwd?: string | null): Promise<T> {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const result = unwrapSettings(await apiRequest<T & SettingsEnvelope>(`/api/settings/compaction${query}`, json("PUT", { enabled, threshold_percent: thresholdPercent })), "Unable to save context management settings");
    invalidateSettings();
    return result;
  },
};

/** Every settings write drops the whole settings resource from cache. */
export function invalidateSettings(): void {
  void queryClient.invalidateQueries({ queryKey: settingsKey() });
}
