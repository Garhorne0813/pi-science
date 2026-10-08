import type { DefaultModelSelection, ModelSelection, SessionModelSelection } from "@pi-science/contracts";
import type { AvailableModel } from "./client/pi-science-client";
import { apiRequest } from "./client/api";
import { queryClient } from "./client/query-client";
import { parseWirePayload } from "./client/wire-schema";

export const modelSelectionKeys = {
  default: ["model-selection", "default"] as const,
  session: (cwd: string, id: string) => ["model-selection", "session", cwd, id] as const,
  catalog: (cwd: string | null) => ["settings", "model-catalog", cwd] as const,
};
const sessionPath = (cwd: string, id: string) => `/api/sessions/${encodeURIComponent(id)}/model-selection?cwd=${encodeURIComponent(cwd)}`;
const json = (selection: ModelSelection) => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(selection) });
async function readDefault(init?: RequestInit, cwd: string | null = null): Promise<DefaultModelSelection> {
  const response = await apiRequest(`/api/model-selection/default${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`, init);
  const { defaultModelSelectionSchema } = await import("@pi-science/contracts");
  return parseWirePayload(response, defaultModelSelectionSchema, "Unable to load default model");
}
async function readSession(cwd: string, id: string, init?: RequestInit): Promise<SessionModelSelection> {
  const response = await apiRequest(sessionPath(cwd, id), init);
  const { sessionModelSelectionSchema } = await import("@pi-science/contracts");
  const result = parseWirePayload(response, sessionModelSelectionSchema, "Unable to load session model");
  if (result.session_id !== id) throw new Error("Model selection belongs to a different session");
  return result;
}
export const modelSelectionApi = {
  readDefault, readSession,
  catalogQuery: (cwd: string | null) => ({ queryKey: modelSelectionKeys.catalog(cwd), queryFn: ({ signal }: { signal: AbortSignal }) => apiRequest<{ available_models: AvailableModel[] }>(`/api/model-selection/catalog${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`, { signal }) }),
  async saveDefault(selection: ModelSelection, cwd: string | null = null) {
    await queryClient.cancelQueries({ queryKey: modelSelectionKeys.default });
    const result = await readDefault(json(selection), cwd);
    queryClient.setQueryData(modelSelectionKeys.default, result);
    void queryClient.invalidateQueries({ queryKey: ["settings", "config"] }).catch(() => undefined);
    return result;
  },
  async saveSession(cwd: string, id: string, selection: ModelSelection) {
    const key = modelSelectionKeys.session(cwd, id);
    await queryClient.cancelQueries({ queryKey: key });
    const result = await readSession(cwd, id, json(selection));
    queryClient.setQueryData(key, result);
    return result;
  },
};
