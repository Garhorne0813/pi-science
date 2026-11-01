import { identifierUrl, scanIdentifiers } from "@pi-science/contracts";

export type { CitationIdentifierKind, CitationIdentifierMatch } from "@pi-science/contracts";
export { identifierFromUrl, identifierUrl, maskNonProse, arxivIdOf, arxivVersionOf } from "@pi-science/contracts";

export interface Citation {
  kind: "doi" | "arxiv";
  /** Version-less source identity: the dedupe and evidence-lookup key. */
  id: string;
  /** Identifier as cited, arXiv version suffix included. */
  requested_id: string;
  url: string;
}

/** One identifier where the document wrote it, so a caller can insert a marker
 *  at that exact offset. Offsets index the text as given, not the masked copy. */
export interface CitationOccurrence extends Citation {
  start: number;
  end: number;
  /** arXiv version as cited, `null` for a DOI or an unversioned arXiv id. */
  requested_version: string | null;
}

export function scanCitations(text: string): CitationOccurrence[] {
  return scanIdentifiers(text).map((match) => ({ kind: match.kind, id: match.id, requested_id: match.requested_id, url: identifierUrl(match.kind, match.requested_id), start: match.start, end: match.end, requested_version: match.requested_version }));
}

/** Every source a text cites, in first-citation order. An arXiv paper cited as
 *  v1 in one place and v2 in another is two entries: a reader tracing the v2
 *  claim must not land on the v1 text. */
export function extractCitations(text: string): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const { kind, id, requested_id, url } of scanCitations(text)) {
    const key = `${kind}:${requested_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ kind, id, requested_id, url });
  }
  return citations;
}
