import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { AutoResearchSnapshot, ResearchSseEvent } from "@pi-science/contracts";
import { apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

export type CreateResearchGraphInput = {
  title: string;
  objective: string;
  project_id?: string;
  origin_session_id?: string | null;
  origin_message_id?: string | null;
  constraints?: string[];
  budget?: Partial<AutoResearchSnapshot["budget"]>;
  target_metrics?: AutoResearchSnapshot["target_metrics"];
};

export const researchGraphKey = (cwd?: string, researchId?: string) =>
  ["research-graphs", cwd, researchId].filter((part) => part !== undefined);

const params = (cwd: string) => new URLSearchParams({ cwd }).toString();

export const researchGraphApi = {
  list: (cwd: string) => apiRequest<{ research: AutoResearchSnapshot[] }>(`/api/research?${params(cwd)}`),
  detail: (cwd: string, researchId: string) => apiRequest<AutoResearchSnapshot>(`/api/research/${encodeURIComponent(researchId)}?${params(cwd)}`),
  create: (cwd: string, input: CreateResearchGraphInput) => apiRequest<AutoResearchSnapshot>(`/api/research?${params(cwd)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }),
  action: (cwd: string, researchId: string, action: "start" | "pause" | "resume" | "cancel") =>
    apiRequest<AutoResearchSnapshot>(`/api/research/${encodeURIComponent(researchId)}/${action}?${params(cwd)}`, { method: "POST" }),
  updateConstraints: (cwd: string, researchId: string, constraints: string[]) =>
    apiRequest<AutoResearchSnapshot>(`/api/research/${encodeURIComponent(researchId)}/constraints?${params(cwd)}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ constraints }),
    }),
  resolveInput: (cwd: string, researchId: string, nodeId: string, resolution: string) =>
    apiRequest<AutoResearchSnapshot>(`/api/research/${encodeURIComponent(researchId)}/input/${encodeURIComponent(nodeId)}?${params(cwd)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolution }),
    }),
};

export function useResearchGraphs(cwd: string) {
  return useQuery({ queryKey: researchGraphKey(cwd), queryFn: () => researchGraphApi.list(cwd) });
}

export function useResearchGraph(cwd: string, researchId: string | null) {
  return useQuery({
    queryKey: researchGraphKey(cwd, researchId ?? ""),
    queryFn: () => researchGraphApi.detail(cwd, researchId!),
    enabled: Boolean(researchId), placeholderData: keepPreviousData,
  });
}

const eventTypes: ResearchSseEvent["type"][] = [
  "research.created", "research.started", "research.snapshot", "research.progress.updated",
  "research.activity.changed", "research.best_result.updated", "research.input.required",
  "research.finding.created", "research.completed", "research.failed",
];

/** Product-event stream. Events are hints; REST snapshots remain authoritative. */
export function subscribeResearchGraphEvents(cwd: string, onEvent?: (event: ResearchSseEvent) => void): () => void {
  const stream = new EventSource(`/api/research-events?${params(cwd)}`);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const invalidate = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void queryClient.invalidateQueries({ queryKey: researchGraphKey(cwd) });
    }, 250);
  };
  const listeners = eventTypes.map((type) => {
    const listener = (raw: MessageEvent<string>) => {
      try { onEvent?.(JSON.parse(raw.data) as ResearchSseEvent); } catch { /* REST refetch repairs malformed hints. */ }
      invalidate();
    };
    stream.addEventListener(type, listener as EventListener);
    return [type, listener] as const;
  });
  stream.addEventListener("open", invalidate);
  return () => {
    listeners.forEach(([type, listener]) => stream.removeEventListener(type, listener as EventListener));
    stream.removeEventListener("open", invalidate);
    stream.close();
    if (timer !== null) clearTimeout(timer);
  };
}
