import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

/**
 * The single REST cache. TanStack Query owns caching, in-flight deduplication,
 * invalidation and retry for every GET in the app; `apiRequest` is the transport
 * underneath it and mutations call that transport directly.
 *
 * ── Query key scheme ────────────────────────────────────────────────────────
 * Keys are `[resource, ...selector]` so a whole resource can be invalidated by
 * its prefix — `invalidateQueries({ queryKey: ["project-memory"] })`. `cwd` is
 * part of the key wherever the server scopes the resource to a workspace.
 *
 *   ["project-memory", "overview" | "timeline" | "experiences", cwd, ...]
 *   ["project-memory", "research-loops", cwd]            loop list
 *   ["project-memory", "research-loops", cwd, loopId]    loop detail
 *   ["project-memory", "research-loops", cwd, loopId, "frontier"]
 *   ["project-knowledge", "summary" | "project" | "proposals" | "items" | …, cwd, …]
 *   ["settings", "config", cwd | null]                   ["settings", "skills"]
 *   ["skills", "list", cwd]                              ["skills", "tools"]
 *   ["workspace-files", cwd, subdir]                     entries + breadcrumbs
 *   ["runs", cwd]                                        ["runs", cwd, runId, "log"]
 *   ["provenance", cwd, "versions" | "env", path | hash]
 *   ["slash-commands", cwd, sessionId]
 *   ["pdf-search", cwd, path, query]                     ["compute", "machines"]
 *   ["notebooks", cwd] / ["notebooks", "jupyter", cwd] / ["environments", cwd]
 *   ["workspaces"] / ["workspaces", "pinned"]
 *
 * ── Defaults ────────────────────────────────────────────────────────────────
 * They reproduce what the hand-rolled cache in api.ts did, nothing more:
 *   • staleTime 3s — the dominant TTL of the wrappers this replaces. Queries
 *     that were uncached before set `staleTime: 0` explicitly at their call site.
 *   • retry once on network failures and 5xx, with the same 150ms backoff.
 *   • refetchOnWindowFocus off — no code in this app ever refetched on focus.
 */

/** Mirrors the old apiRequest retry predicate: anything that is not an HTTP error, or a 5xx. */
export function isRetryableApiError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 3_000,
      retry: (failureCount, error) => failureCount < 1 && isRetryableApiError(error),
      retryDelay: (attemptIndex) => 150 * (attemptIndex + 1),
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});
