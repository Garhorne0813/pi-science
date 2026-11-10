/**
 * One rule for finding DOI and arXiv identifiers, shared by the renderer, the
 * copy path and server-side verification.
 *
 * It lives here because three copies already drifted. The copy that fed the
 * numbering stopped a DOI at `[`, the copy that fed the renderer did not, so
 * `10.1000/alpha[1]` rendered as a link to `10.1000/alpha[1` while the
 * reference list numbered `10.1000/alpha`. A reader then followed a link to a
 * source that does not exist.
 */

export type CitationIdentifierKind = "doi" | "arxiv";

/** One identifier where the document wrote it, with the offsets that delimit
 *  it, so a caller can put a marker straight after the identifier itself. */
export interface CitationIdentifierMatch {
  kind: CitationIdentifierKind;
  /** Version-less source identity: the dedupe, query and cache key. */
  id: string;
  /** The identifier as written, arXiv version included. */
  requested_id: string;
  /** arXiv version as written, digits only, or null. */
  requested_version: string | null;
  /** Offset of the first character in the scanned text. */
  start: number;
  /** Offset one past the last character. */
  end: number;
  /** Where the identifier's own label begins, counting a `doi:`/`DOI :` scheme
   *  written immediately before it. `start` is where the identifier itself
   *  begins and is what a marker insertion wants; this is what a renderer
   *  wants, because the scheme belongs to the citation and leaving it in the
   *  prose printed `doi:` in front of the body number. Equal to `start`
   *  whenever the document wrote no scheme. */
  label_start: number;
}

// DOI suffixes are ASCII per the DOI spec, but the prose around them is not.
// The match must terminate at CJK ideographs/kana/hangul and CJK, fullwidth or
// general punctuation, or a Chinese sentence glues its words onto the id. It
// must also stop at `[`, or a numbered marker written straight after an
// identifier (`10.1000/alpha[1]`) is read back as part of the id.
const DOI_PATTERN =
  /10\.\d{4,9}\/[^\s[\])\}>\u2010-\u2027\u2030-\u205e\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]+/gi;
const ARXIV_PATTERN = /arXiv:\s?(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
const ARXIV_VERSION = /v(\d+)$/i;
// Trimming the trailing run with one regex (`/[.,;:!?*"'\u2010-\u2027...]+$/`)
// makes the engine walk back over the run at every start offset it rejects, so a
// long run of `!` inside a document or a URL costs quadratic time. CodeQL grades
// that `js/polynomial-redos`. Reading the string backwards touches each
// character once and trims exactly the same set.
const TRAILING_ASCII_PUNCTUATION = ".,;:!?*\"'";
const TRAILING_PUNCTUATION_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2010, 0x2027],
  [0x2030, 0x205e],
  [0x3000, 0x303f],
  [0xff00, 0xffef],
];
function isTrailingPunctuation(char: string): boolean {
  if (TRAILING_ASCII_PUNCTUATION.includes(char)) return true;
  const code = char.codePointAt(0) ?? 0;
  return TRAILING_PUNCTUATION_RANGES.some(([from, to]) => code >= from && code <= to);
}
function trimTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && isTrailingPunctuation(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}
const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /`+[^`\n]*`+/g;
const MATH_BLOCK = /\$\$[\s\S]*?\$\$/g;
const MATH_INLINE = /\$[^$\n]+\$/g;

/** `doi:`, `DOI :` or `doi: ` written straight before an identifier. arXiv's
 *  already sits inside its own match, so only the DOI form needs reading back.
 *  A preceding ASCII letter or digit disqualifies it: `xdoi:` is a word, not a
 *  scheme. Anything else may precede it, because Chinese prose glues the
 *  scheme onto the word before it (`见doi:10.…`), and requiring a space there
 *  left `doi:` in half the real answers. */
const SCHEME_TAIL = /doi[ \t]*:[ \t]*$/i;
const SCHEME_LOOKBACK = 24;

function schemeStart(text: string, start: number): number {
  const from = Math.max(0, start - SCHEME_LOOKBACK);
  const match = SCHEME_TAIL.exec(text.slice(from, start));
  if (!match) return start;
  const at = from + match.index;
  return at > 0 && /[A-Za-z0-9]/.test(text[at - 1]!) ? start : at;
}

export function arxivVersionOf(requestedId: string): string | null {
  return ARXIV_VERSION.exec(requestedId)?.[1] ?? null;
}

export function arxivIdOf(requestedId: string): string {
  return requestedId.replace(ARXIV_VERSION, "");
}

const blankRun = (run: string): string => run.replace(/[^\n]/g, " ");

/** Blank out fenced code, inline code and math while keeping every offset and
 *  newline, so a scan over the result points at the same characters in the
 *  original. The renderer never turns these into citations, and a number the
 *  body does not show must not appear in the reference list either. */
export function maskNonProse(text: string): string {
  const chars = text.split("");
  const blank = (from: number, to: number) => {
    for (let index = from; index < to && index < chars.length; index += 1)
      if (chars[index] !== "\n") chars[index] = " ";
  };
  let open: { char: string; length: number; at: number } | null = null;
  for (let lineStart = 0; lineStart <= text.length; ) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const fence = FENCE_LINE.exec(text.slice(lineStart, lineEnd))?.[1] ?? null;
    if (!open && fence) open = { char: fence[0]!, length: fence.length, at: lineStart };
    else if (open && fence && fence[0] === open.char && fence.length >= open.length) {
      blank(open.at, lineEnd);
      open = null;
    }
    if (newline === -1) break;
    lineStart = lineEnd + 1;
  }
  if (open) blank(open.at, text.length);
  return chars
    .join("")
    .replace(MATH_BLOCK, blankRun)
    .replace(MATH_INLINE, blankRun)
    .replace(INLINE_CODE, blankRun);
}

/** Every identifier in prose, in document order, repeats included. Offsets index
 *  the text as given, not the masked copy. */
export function scanIdentifiers(text: string): CitationIdentifierMatch[] {
  const prose = maskNonProse(text);
  const found: CitationIdentifierMatch[] = [];
  for (const match of prose.matchAll(DOI_PATTERN)) {
    const start = match.index ?? 0;
    const cleaned = trimTrailingPunctuation(text.slice(start, start + match[0].length));
    if (cleaned.endsWith("/")) continue;
    const id = cleaned.toLowerCase();
    found.push({
      kind: "doi",
      id,
      requested_id: id,
      requested_version: null,
      start,
      end: start + cleaned.length,
      label_start: schemeStart(text, start),
    });
  }
  for (const match of prose.matchAll(ARXIV_PATTERN)) {
    const requestedId = match[1]!;
    const start = match.index ?? 0;
    found.push({
      kind: "arxiv",
      id: arxivIdOf(requestedId),
      requested_id: requestedId,
      requested_version: arxivVersionOf(requestedId),
      start,
      end: start + match[0].length,
      label_start: start,
    });
  }
  return found.sort((left, right) => left.start - right.start);
}

const RESOLVER_URL = /^https?:\/\/(?:dx\.)?doi\.org\/(10\.[^?#\s]+)$/i;
const ARXIV_URL =
  /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/i;

/** The identifier an ordinary Markdown link points at. A link written as
 *  `[the paper](https://doi.org/10.1000/alpha)` asserts the same source as a
 *  bare identifier, so it gets a body number; its own text keeps its meaning. */
export function identifierFromUrl(url: string): {
  kind: CitationIdentifierKind;
  id: string;
  requested_id: string;
  requested_version: string | null;
} | null {
  const doi = RESOLVER_URL.exec(url.trim());
  if (doi?.[1]) {
    const id = trimTrailingPunctuation(decodeURIComponent(doi[1])).toLowerCase();
    if (id.endsWith("/")) return null;
    return { kind: "doi", id, requested_id: id, requested_version: null };
  }
  const arxiv = ARXIV_URL.exec(url.trim());
  if (arxiv?.[1])
    return {
      kind: "arxiv",
      id: arxivIdOf(arxiv[1]),
      requested_id: arxiv[1],
      requested_version: arxivVersionOf(arxiv[1]),
    };
  return null;
}

/** The resolver a reader lands on for one identifier as written. */
export function identifierUrl(kind: CitationIdentifierKind, requestedId: string): string {
  return kind === "doi" ? `https://doi.org/${requestedId}` : `https://arxiv.org/abs/${requestedId}`;
}
