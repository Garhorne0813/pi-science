import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../client/api";

/** Why a source has no located passage. Each one is a different fact and the
 *  card says which: "we could not fetch the paper", "we fetched it and it had
 *  no readable text", "we read it and nothing matched this sentence", and "we
 *  have not looked yet" are not interchangeable. */
export type FullTextState = "available" | "no_open_fulltext" | "access_denied" | "download_failed" | "parse_failed" | "no_text_layer" | "version_mismatch";

/** `stale` is a recorded citation whose source has been read again since: the
 *  passages it named no longer resolve, and quoting the new text in their place
 *  would show the reader a paragraph the answer never used. */
export type PositionState = FullTextState | "matched" | "no_match" | "unfetched" | "stale";

/** Where the passages came from. `generation` is the model's own choice,
 *  recorded while it wrote the sentence; `located` is a passage found by
 *  reading the finished sentence afterwards. A card never shows one as the
 *  other. */
export type EvidenceOrigin = "generation" | "located";

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
  /** Retrieval rank, never a probability that the passage supports the claim.
   *  Null when the model chose the passage: a choice carries no score. */
  score: number | null;
  /** Identity inside the snapshot the passage was read from. */
  passage_id: string;
}

export interface CitationPosition {
  key: string;
  claim_sha256: string;
  state: PositionState;
  note: string | null;
  snapshot_sha256: string | null;
  snapshot_id: string | null;
  origin: EvidenceOrigin;
  excerpts: CitationExcerpt[];
  /** What a search of the same snapshot offered beside a generation-time
   *  record. Absent when there is no record, because then the search result is
   *  the answer and not a supplement to it. */
  supplementary?: CitationExcerpt[];
}

export interface CitationPositionRequest { key: string; claim: string }

/** A lookup is keyed by the source, the claim and whether the caller allowed a
 *  network fetch. Hovering must not spend a request on a provider, so the two
 *  modes must not share a cache entry. */
export const citationPositionKey = (cwd: string, sessionId: string | null, request: CitationPositionRequest, allowFetch: boolean) =>
  ["citations", "position", cwd, sessionId ?? "", request.key, request.claim, allowFetch] as const;

/** The passages behind one citation position. A position the session recorded
 *  while it wrote answers from that record; anything else is a passage found by
 *  reading the sentence afterwards, and the result says which. Without
 *  `allowFetch` this reads only what the workspace already holds. */
export function useCitationPosition(cwd: string, sessionId: string | null, request: CitationPositionRequest | null, allowFetch: boolean): { position: CitationPosition | undefined; isLoading: boolean; refetch: () => void } {
  const { data, isLoading, refetch } = useQuery({
    queryKey: citationPositionKey(cwd, sessionId, request ?? { key: "", claim: "" }, allowFetch),
    queryFn: () => apiRequest<{ positions: CitationPosition[] }>(`/api/citations/passages?cwd=${encodeURIComponent(cwd)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fetch: allowFetch, session_id: sessionId ?? undefined, positions: [request] }) }),
    enabled: Boolean(cwd) && Boolean(request?.key) && Boolean(request?.claim?.trim()),
    // A matched excerpt never changes for a given claim and snapshot, and a
    // miss is not retried behind the reader's back.
    staleTime: 10 * 60_000,
    retry: false,
  });
  return { position: data?.positions?.[0], isLoading, refetch: () => { void refetch(); } };
}
