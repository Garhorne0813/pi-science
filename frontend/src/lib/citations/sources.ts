import { useQuery } from "@tanstack/react-query";
import { citationSourcesResponseSchema, type CitationSource } from "@pi-science/contracts";
import { apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

const API = "/api/citations/sources";

export const citationSourcesKey = (cwd: string | undefined, sessionId: string | undefined) => ["citation-sources", cwd, sessionId];

/** Captured sources for one session. A missing session has no registry to read,
 *  so the query stays disabled instead of asking the server for nothing. */
export function useCitationSources(cwd: string | undefined, sessionId: string | undefined): CitationSource[] {
  const enabled = Boolean(cwd && sessionId && sessionId !== "scratch");
  const { data } = useQuery({
    queryKey: citationSourcesKey(cwd, sessionId),
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      try {
        const params = new URLSearchParams({ cwd: cwd ?? "", sessionId: sessionId ?? "" });
        return citationSourcesResponseSchema.parse(await apiRequest<unknown>(`${API}?${params}`)).sources;
      } catch {
        return [];
      }
    },
  }, queryClient);
  return data ?? [];
}
