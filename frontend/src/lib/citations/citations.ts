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

// DOI suffixes are ASCII per the DOI spec, but the prose around them is not.
// The match must terminate at CJK ideographs/kana/hangul and CJK, fullwidth or
// general punctuation, or a Chinese sentence glues its words onto the id. It
// must also stop at `[`, or a numbered marker written straight after an
// identifier (`10.1000/alpha[1]`) would be read back as part of the id. Keep
// in sync with apps/server/src/runtime/citations/citation-verify-service.ts.
const DOI_PATTERN = /10\.\d{4,9}\/[^\s)\][}>\u2010-\u2027\u2030-\u205e\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]+/gi;
const ARXIV_PATTERN = /arXiv:\s?(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
const TRAILING_PUNCTUATION = /[.,;:!?*"'\u2010-\u2027\u2030-\u205e\u3000-\u303f\uff00-\uffef]+$/;
const ARXIV_VERSION = /v(\d+)$/i;
const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /`+[^`\n]*`+/g;
const MATH_BLOCK = /\$\$[\s\S]*?\$\$/g;
const MATH_INLINE = /\$[^$\n]+\$/g;

const blankRun = (run: string): string => run.replace(/[^\n]/g, " ");

/** Blank out fenced code, inline code and math while keeping every offset and
 *  newline, so a scan over the result points at the same characters in the
 *  original. The renderer never turns these into citations, and a number the
 *  body does not show must not appear in the reference list either. */
export function maskNonProse(text: string): string {
  const chars = text.split("");
  const blank = (from: number, to: number) => {
    for (let index = from; index < to && index < chars.length; index += 1) if (chars[index] !== "\n") chars[index] = " ";
  };
  let open: { char: string; length: number; at: number } | null = null;
  for (let lineStart = 0; lineStart <= text.length; ) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const fence = FENCE_LINE.exec(text.slice(lineStart, lineEnd))?.[1] ?? null;
    if (!open && fence) open = { char: fence[0]!, length: fence.length, at: lineStart };
    else if (open && fence && fence[0] === open.char && fence.length >= open.length) { blank(open.at, lineEnd); open = null; }
    if (newline === -1) break;
    lineStart = lineEnd + 1;
  }
  if (open) blank(open.at, text.length);
  return chars.join("").replace(MATH_BLOCK, blankRun).replace(MATH_INLINE, blankRun).replace(INLINE_CODE, blankRun);
}

/** Every identifier in prose, in document order, repeats included. One scan
 *  feeds both the source list and the numbering, so the two cannot disagree
 *  about which sources the answer cites. */
export function scanCitations(text: string): CitationOccurrence[] {
  const prose = maskNonProse(text);
  const found: CitationOccurrence[] = [];
  for (const match of prose.matchAll(DOI_PATTERN)) {
    const start = match.index ?? 0;
    const cleaned = text.slice(start, start + match[0].length).replace(TRAILING_PUNCTUATION, "");
    if (cleaned.endsWith("/")) continue;
    const id = cleaned.toLowerCase();
    found.push({ kind: "doi", id, requested_id: id, url: `https://doi.org/${id}`, start, end: start + cleaned.length, requested_version: null });
  }
  for (const match of prose.matchAll(ARXIV_PATTERN)) {
    const requestedId = match[1]!;
    const start = match.index ?? 0;
    found.push({ kind: "arxiv", id: requestedId.replace(ARXIV_VERSION, ""), requested_id: requestedId, url: `https://arxiv.org/abs/${requestedId}`, start, end: start + match[0].length, requested_version: ARXIV_VERSION.exec(requestedId)?.[1] ?? null });
  }
  return found.sort((left, right) => left.start - right.start);
}

/** Extract DOI and arXiv identifiers from agent text, deduped by source
 *  identity in first-seen order. The same arXiv paper cited as v1 and v2 is
 *  one source, so it stays one chip while `requested_id` keeps the version
 *  the reader should land on. */
export function extractCitations(text: string): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const { kind, id, requested_id, url } of scanCitations(text)) {
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ kind, id, requested_id, url });
  }
  return citations;
}
