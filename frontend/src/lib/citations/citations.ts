export interface Citation {
  kind: "doi" | "arxiv";
  id: string;
  url: string;
}

const DOI_PATTERN = /10\.\d{4,9}\/[^\s)\]}>]+/gi;
const ARXIV_PATTERN = /arXiv:\s?(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
const TRAILING_PUNCTUATION = /[.,;:!?*"']+$/;

/** Extract DOI and arXiv identifiers from agent text, deduped in first-seen order. */
export function extractCitations(text: string): Citation[] {
  const found: Array<Citation & { index: number }> = [];
  for (const match of text.matchAll(DOI_PATTERN)) {
    const id = match[0].replace(TRAILING_PUNCTUATION, "").toLowerCase();
    if (id.endsWith("/")) continue;
    found.push({ kind: "doi", id, url: `https://doi.org/${id}`, index: match.index ?? 0 });
  }
  for (const match of text.matchAll(ARXIV_PATTERN)) {
    const id = match[1];
    found.push({ kind: "arxiv", id, url: `https://arxiv.org/abs/${id}`, index: match.index ?? 0 });
  }
  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const { kind, id, url } of found) {
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ kind, id, url });
  }
  return citations;
}
