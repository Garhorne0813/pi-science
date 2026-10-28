export interface Citation {
  kind: "doi" | "arxiv";
  /** Version-less source identity: the dedupe and evidence-lookup key. */
  id: string;
  /** Identifier as cited, arXiv version suffix included. */
  requested_id: string;
  url: string;
}

// DOI suffixes are ASCII per the DOI spec, but the prose around them is not.
// The match must terminate at CJK ideographs/kana/hangul and CJK, fullwidth or
// general punctuation, or a Chinese sentence glues its words onto the id. Keep
// in sync with apps/server/src/runtime/citations/citation-verify-service.ts.
const DOI_PATTERN = /10\.\d{4,9}\/[^\s)\]}>\u2010-\u2027\u2030-\u205e\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]+/gi;
const ARXIV_PATTERN = /arXiv:\s?(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
const TRAILING_PUNCTUATION = /[.,;:!?*"'\u2010-\u2027\u2030-\u205e\u3000-\u303f\uff00-\uffef]+$/;
const ARXIV_VERSION = /v\d+$/i;

/** Extract DOI and arXiv identifiers from agent text, deduped by source
 *  identity in first-seen order. The same arXiv paper cited as v1 and v2 is
 *  one source, so it stays one chip while `requested_id` keeps the version
 *  the reader should land on. */
export function extractCitations(text: string): Citation[] {
  const found: Array<Citation & { index: number }> = [];
  for (const match of text.matchAll(DOI_PATTERN)) {
    const id = match[0].replace(TRAILING_PUNCTUATION, "").toLowerCase();
    if (id.endsWith("/")) continue;
    found.push({ kind: "doi", id, requested_id: id, url: `https://doi.org/${id}`, index: match.index ?? 0 });
  }
  for (const match of text.matchAll(ARXIV_PATTERN)) {
    const requestedId = match[1]!;
    found.push({ kind: "arxiv", id: requestedId.replace(ARXIV_VERSION, ""), requested_id: requestedId, url: `https://arxiv.org/abs/${requestedId}`, index: match.index ?? 0 });
  }
  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const { kind, id, requested_id, url } of found) {
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ kind, id, requested_id, url });
  }
  return citations;
}
