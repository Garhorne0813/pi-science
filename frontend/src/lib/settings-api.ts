import { applySessionReplacements, type SessionReplacement } from "./runtime-store";

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

export const settingsApi = {
  async config<T>(cwd?: string | null): Promise<T> {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    return readSettingsResponse<T>(await fetch(`/api/settings/config${query}`), "Unable to load settings");
  },

  async saveApiKey(provider: string, apiKey: string): Promise<void> {
    await readSettingsResponse(await fetch("/api/settings/api-key", json("PUT", { provider, api_key: apiKey })), "Unable to save API key");
  },

  async deleteApiKey(provider: string): Promise<void> {
    await readSettingsResponse(await fetch(`/api/settings/api-key/${encodeURIComponent(provider)}`, { method: "DELETE" }), "Unable to delete API key");
  },

  async saveModel<T>(model: string, thinking: string, cwd?: string | null): Promise<T> {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    return readSettingsResponse<T>(await fetch(`/api/settings/model${query}`, json("PUT", { model, thinking })), "Unable to save default model");
  },
};
