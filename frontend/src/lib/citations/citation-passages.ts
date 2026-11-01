import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../client/api";

/** Why a source has no located passage. Each one is a different fact and the
 *  card says which: "we could not fetch the paper", "we fetched it and it had
 *  no readable text", "we read it and nothing matched this sentence", and "we
 *  have not looked yet" are not interchangeable. */
export type FullTextState = "available" | "no_open_fulltext" | "access_denied" | "download_failed" | "parse_failed" | "no_text_layer" | "version_mismatch";

export type PositionState = FullTextState | "matched" | "no_match" | "unfetched";

/** One passage, verbatim from the snapshot the server holds. `before` and
 *  `after` are the surrounding paragraphs, also verbatim, so the reader can
 *  judge the excerpt instead of trusting it. */
export interface CitationExcerpt {
  text: string;
  before: string;
  after: string;
  section_title: string | null;
  section_id: string | null;
  page: number | null;
  /** Retrieval rank, never a probability that the passage supports the claim. */
  score: number;
}

export interface CitationPosition {
  key: string;
  claim_sha256: string;
  state: PositionState;
  note: string | null;
  snapshot_sha256: string | null;
  excerpts: CitationExcerpt[];
}

export interface CitationPositionRequest { key: string; claim: string }

/** A lookup is keyed by the source, the claim and whether the caller allowed a
 *  network fetch. Hovering must not spend a request on a provider, so the two
 *  modes must not share a cache entry. */
export const citationPositionKey = (cwd: string, request: CitationPositionRequest, allowFetch: boolean) =>
  ["citations", "position", cwd, request.key, request.claim, allowFetch] as const;

/** Locate the passages that are relevant to one citation position. Without
 *  `allowFetch` this reads only what the workspace already holds. */
export function useCitationPosition(cwd: string, request: CitationPositionRequest | null, allowFetch: boolean): { position: CitationPosition | undefined; isLoading: boolean; refetch: () => void } {
  const { data, isLoading, refetch } = useQuery({
    queryKey: citationPositionKey(cwd, request ?? { key: "", claim: "" }, allowFetch),
    queryFn: () => apiRequest<{ positions: CitationPosition[] }>(`/api/citations/passages?cwd=${encodeURIComponent(cwd)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fetch: allowFetch, positions: [request] }) }),
    enabled: Boolean(cwd) && Boolean(request?.key) && Boolean(request?.claim?.trim()),
    // A matched excerpt never changes for a given claim and snapshot, and a
    // miss is not retried behind the reader's back.
    staleTime: 10 * 60_000,
    retry: false,
  });
  return { position: data?.positions?.[0], isLoading, refetch: () => { void refetch(); } };
}
