import { applySessionReplacements, type SessionReplacement } from "../agent-runtime";
import { apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";
import type { AgentProfile, CustomProvider, McpServer, ModelEndpoint, ProjectSubagent, RuntimeExtension, WebAccessConfig } from "./settings-types";

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

/** Raw-Response variant kept for `pi-science-client.test.ts`, which pins `error` over `detail`. */
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

/** Routes that answer through `respondWithReload` need the envelope check plus the
 *  session-replacement side effect; everything else only needs the transport. */
async function writeSettings<T>(path: string, init: RequestInit, fallback: string): Promise<T> {
  return unwrapSettings(await apiRequest<T & SettingsEnvelope>(path, { ...init, errorFallback: fallback }), fallback);
}

/** Config is read often and changes rarely — it kept a 3s TTL, now the client default. */
const configQuery = <T,>(cwd?: string | null) => ({
  queryKey: settingsKey("config", cwd ?? null),
  queryFn: () => apiRequest<T & SettingsEnvelope>(`/api/settings/config${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`),
});

/* ── Query definitions for the settings page's own reads ──────────────────────
 * None of these were cached before A6 migrated them off raw `fetch`, so they all
 * pin `staleTime: 0`: every mount is a fresh read, the shared client only adds
 * in-flight deduplication and the 5xx retry. Only `/api/settings/*` resources sit
 * under the `settings` key so `invalidateSettings()` keeps its existing blast radius. */

export const extensionsQuery = (errorFallback: string) => ({
  queryKey: settingsKey("extensions"),
  queryFn: () => apiRequest<{ extensions?: RuntimeExtension[] }>("/api/settings/extensions", { errorFallback }),
  staleTime: 0,
});

export const subagentsKey = (cwd: string) => settingsKey("subagents", cwd);
export const subagentsQuery = (cwd: string, errorFallback: string) => ({
  queryKey: subagentsKey(cwd),
  queryFn: () => apiRequest<{ agents?: ProjectSubagent[] }>(`/api/settings/subagents?cwd=${encodeURIComponent(cwd)}`, { errorFallback }),
  staleTime: 0,
});
export const subagentsDiscoveryKey = (cwd: string) => settingsKey("subagents-discovery", cwd);
export const subagentsDiscoveryQuery = (cwd: string) => ({
  queryKey: subagentsDiscoveryKey(cwd),
  queryFn: () => apiRequest<{ agents?: Array<{ name: string; description?: string; source?: string }> }>(`/api/settings/subagents/discovery?cwd=${encodeURIComponent(cwd)}`),
  staleTime: 3_000,
});

export const webAccessKey = settingsKey("web-access");
export const webAccessQuery = (errorFallback: string) => ({
  queryKey: webAccessKey,
  queryFn: () => apiRequest<WebAccessConfig>("/api/settings/web-access", { errorFallback }),
  staleTime: 0,
});

export const modelEndpointsKey = ["model-endpoints"];
export const modelEndpointsQuery = (errorFallback: string) => ({
  queryKey: modelEndpointsKey,
  queryFn: () => apiRequest<{ endpoints?: ModelEndpoint[] }>("/api/endpoints", { errorFallback }),
  staleTime: 0,
});

export const agentProfilesKey = ["agent-profiles"];
export const agentProfilesQuery = (errorFallback: string) => ({
  queryKey: agentProfilesKey,
  queryFn: () => apiRequest<{ profiles?: AgentProfile[] }>("/api/agent-profiles", { errorFallback }),
  staleTime: 0,
});

export const mcpCatalogKey = (cwd: string) => ["mcp", "catalog", cwd];
export const mcpCatalogQuery = (cwd: string, errorFallback: string) => ({
  queryKey: mcpCatalogKey(cwd),
  queryFn: () => apiRequest<{ servers?: McpServer[] }>(`/api/mcp/catalog?cwd=${encodeURIComponent(cwd)}`, { errorFallback }),
  staleTime: 0,
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
    // Wait for invalidation before SettingsPage immediately reloads. Without
    // this, fetchQuery can return the still-fresh 3s cached config and keep
    // showing the previous model's context window.
    await invalidateSettings();
    return result;
  },

  async saveCompaction<T>(enabled: boolean, thresholdPercent: number, cwd?: string | null): Promise<T> {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const result = unwrapSettings(await apiRequest<T & SettingsEnvelope>(`/api/settings/compaction${query}`, json("PUT", { enabled, threshold_percent: thresholdPercent })), "Unable to save context management settings");
    invalidateSettings();
    return result;
  },

  /* ── Custom API providers ── */

  discoverCustomProvider(input: { name: string; base_url: string; api_key: string; api: string }, fallback: string) {
    return writeSettings<{ provider: CustomProvider }>("/api/settings/custom-providers/discover", json("POST", input), fallback);
  },

  async saveCustomProvider(id: string, body: Record<string, unknown>, fallback: string): Promise<void> {
    await writeSettings(`/api/settings/custom-providers/${encodeURIComponent(id)}`, json("PUT", body), fallback);
    invalidateSettings();
  },

  async deleteCustomProvider(id: string, fallback: string): Promise<void> {
    await writeSettings(`/api/settings/custom-providers/${encodeURIComponent(id)}`, { method: "DELETE" }, fallback);
    invalidateSettings();
  },

  /* ── Web access ── */

  saveWebAccess(body: { provider: string; workflow: string; api_keys: Record<string, string>; remove_keys: string[] }, fallback: string) {
    return writeSettings<WebAccessConfig>("/api/settings/web-access", json("PUT", body), fallback);
  },

  /* ── Project subagents ── */

  async saveSubagent(cwd: string, name: string, body: ProjectSubagent, fallback: string): Promise<void> {
    await apiRequest(`/api/settings/subagents/${encodeURIComponent(name)}?cwd=${encodeURIComponent(cwd)}`, { ...json("PUT", body), errorFallback: fallback });
    void queryClient.invalidateQueries({ queryKey: subagentsKey(cwd) });
    void queryClient.invalidateQueries({ queryKey: subagentsDiscoveryKey(cwd) });
  },

  async deleteSubagent(cwd: string, name: string, fallback: string): Promise<void> {
    await apiRequest(`/api/settings/subagents/${encodeURIComponent(name)}?cwd=${encodeURIComponent(cwd)}`, { method: "DELETE", errorFallback: fallback });
    void queryClient.invalidateQueries({ queryKey: subagentsKey(cwd) });
    void queryClient.invalidateQueries({ queryKey: subagentsDiscoveryKey(cwd) });
  },

  /* ── MCP catalog ── */

  setMcpEnabled(id: string, enabled: boolean, fallback: string) {
    return writeSettings(`/api/settings/mcp/${id}?enabled=${enabled}`, { method: "PUT" }, fallback);
  },

  /* ── Model endpoints ── */

  async registerEndpoint(body: { name: string; base_url: string; protocol: string; data_egress: string }, fallback: string): Promise<void> {
    await apiRequest("/api/endpoints", { ...json("POST", body), errorFallback: fallback });
    void queryClient.invalidateQueries({ queryKey: modelEndpointsKey });
  },

  /** The two toggles never checked their response before A6; they still don't. */
  async checkEndpointHealth(endpointId: string): Promise<void> {
    await apiRequest(`/api/endpoints/${encodeURIComponent(endpointId)}/health`, { method: "POST" }).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: modelEndpointsKey });
  },

  async setEndpointEnabled(endpointId: string, enabled: boolean): Promise<void> {
    await apiRequest(`/api/endpoints/${encodeURIComponent(endpointId)}/enabled?enabled=${enabled}`, { method: "PUT" }).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: modelEndpointsKey });
  },

  /* ── Agent profiles ── */

  async createAgentProfile(body: Record<string, unknown>, fallback: string): Promise<void> {
    await apiRequest("/api/agent-profiles", { ...json("POST", body), errorFallback: fallback });
    void queryClient.invalidateQueries({ queryKey: agentProfilesKey });
  },
};

/** Every settings write drops the whole settings resource from cache. */
export function invalidateSettings(): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: settingsKey() }).then(() => undefined);
}
