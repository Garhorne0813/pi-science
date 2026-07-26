import { applySessionReplacements, type SessionReplacement } from "./runtime-store";
import { apiRequest, invalidateApiCache } from "./api";

export async function readSettingsResponse<T>(response: Response, fallback: string): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & {
    error?: string;
    detail?: string;
    session_replacements?: SessionReplacement[];
  };
  if (!response.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error(data.error || data.detail || fallback);
  }
  if (Array.isArray(data.session_replacements)) {
    applySessionReplacements(data.session_replacements);
  }
  return data;
}

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function applySettingsResult<T>(data: T & { ok?: boolean; error?: string; detail?: string; session_replacements?: SessionReplacement[] }, fallback: string): T {
  if (data.ok === false) throw new Error(data.error || data.detail || fallback);
  if (Array.isArray(data.session_replacements)) applySessionReplacements(data.session_replacements);
  return data;
}

export const settingsApi = {
  async config<T>(cwd?: string | null): Promise<T> {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    return applySettingsResult(await apiRequest<T & { ok?: boolean }>(`/api/settings/config${query}`, { cacheTtlMs: 3000 }), "Unable to load settings");
  },

  async saveApiKey(provider: string, apiKey: string): Promise<void> {
    applySettingsResult(await apiRequest<{ ok?: boolean; error?: string; detail?: string; session_replacements?: SessionReplacement[] }>("/api/settings/api-key", json("PUT", { provider, api_key: apiKey })), "Unable to save API key");
    invalidateApiCache("/api/settings/");
  },

  async deleteApiKey(provider: string): Promise<void> {
    applySettingsResult(await apiRequest<{ ok?: boolean; error?: string; detail?: string; session_replacements?: SessionReplacement[] }>(`/api/settings/api-key/${encodeURIComponent(provider)}`, { method: "DELETE" }), "Unable to delete API key");
    invalidateApiCache("/api/settings/");
  },

  async saveModel<T>(model: string, thinking: string, cwd?: string | null): Promise<T> {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const result = applySettingsResult(await apiRequest<T & { ok?: boolean }>(`/api/settings/model${query}`, json("PUT", { model, thinking })), "Unable to save default model");
    invalidateApiCache("/api/settings/");
    return result;
  },

  async saveCompaction<T>(enabled: boolean, thresholdPercent: number, cwd?: string | null): Promise<T> {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const result = applySettingsResult(await apiRequest<T & { ok?: boolean }>(`/api/settings/compaction${query}`, json("PUT", { enabled, threshold_percent: thresholdPercent })), "Unable to save context management settings");
    invalidateApiCache("/api/settings/");
    return result;
  },
};
