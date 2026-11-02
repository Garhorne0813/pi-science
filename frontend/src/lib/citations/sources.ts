import { useQuery } from "@tanstack/react-query";
import { citationSourcesResponseSchema, type CitationSource } from "@pi-science/contracts";
import { apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

const API = "/api/citations/sources";

const scopeKey = (cwd: string | undefined, sessionId: string | undefined) => ["citation-sources", cwd, sessionId];

export const citationSourcesKey = (cwd: string | undefined, sessionId: string | undefined, turnIds: string[] = []) =>
  [...scopeKey(cwd, sessionId), turnIds.join(",")];

/** Captured sources for one answer. A read only binds to the answer whose turn
 *  did it, so every turn keeps its own registry entry. A missing session has no
 *  registry to read, so the query stays disabled instead of asking for nothing. */
export function useCitationSources(cwd: string | undefined, sessionId: string | undefined, turnIds: string[] = []): CitationSource[] {
  const enabled = Boolean(cwd && sessionId && sessionId !== "scratch");
  const { data } = useQuery({
    queryKey: citationSourcesKey(cwd, sessionId, turnIds),
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      try {
        const params = new URLSearchParams({ cwd: cwd ?? "", sessionId: sessionId ?? "" });
        for (const turnId of turnIds) params.append("turnId", turnId);
        return citationSourcesResponseSchema.parse(await apiRequest<unknown>(`${API}?${params}`)).sources;
      } catch {
        return [];
      }
    },
  }, queryClient);
  return data ?? [];
}

/** A finished tool call is new read evidence, and a settled turn may have read
 *  more since the last fetch. Both stale every turn of that session. */
export function invalidateCitationSources(cwd: string | undefined, sessionId: string | undefined): void {
  if (!cwd || !sessionId) return;
  void queryClient.invalidateQueries({ queryKey: scopeKey(cwd, sessionId) });
}
