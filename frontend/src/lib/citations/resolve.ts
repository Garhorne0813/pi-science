import type { CitationSource, CitationSourceKind } from "@pi-science/contracts";
import { extractCitations } from "./citations";

export interface CitationToken {
  kind: CitationSourceKind;
  identity: string;
  start: number;
  end: number;
}

export interface ResolvedCitation {
  index: number;
  token: CitationToken;
  source: CitationSource | null;
}

interface TextSpan { start: number; length: number; }

const IDENTIFIER_KINDS: CitationSourceKind[] = ["doi", "arxiv"];
// Characters that continue a path. A match touching one of these is part of a
// longer name, so `report.md` must not claim `report.md.bak`.
const PATH_CHAR = /[A-Za-z0-9._~+/-]/;
const WEB_URL = /https?:\/\/[^\s<>"'`]+/gi;
const URL_TAIL = ".,;:!?*'\"";
const URL_CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };

/** A source may show its captured text and open the file only while the server
 *  can still read it. A permission failure hides the content, not the card. */
export function citationSourceContentVisible(source: CitationSource | null): boolean {
  return Boolean(source && source.status !== "identifier-only" && source.status !== "forbidden");
}

/** The registry stores a page URL the way `URL` prints it, which adds a
 *  trailing slash and drops the fragment. An answer writes the URL by hand, so
 *  the text side runs the same normalization before the comparison. Keep this in
 *  step with `normalizeWebUrl` in the server's source capture. */
function normalizeWebIdentity(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function countOf(text: string, char: string): number { return text.split(char).length - 1; }

/** A sentence puts punctuation right after a URL, and a markdown link wraps it
 *  in brackets. Neither character belongs to the URL. */
function trimUrlTail(raw: string): string {
  let token = raw;
  for (let last = token.slice(-1); last; last = token.slice(-1)) {
    const opening = URL_CLOSERS[last];
    if (opening ? countOf(token, last) <= countOf(token, opening) : !URL_TAIL.includes(last)) return token;
    token = token.slice(0, -1);
  }
  return token;
}

/** Every page URL the answer wrote, keyed by the identity the registry stores.
 *  Comparing whole URLs is what stops a home page from claiming the evidence of
 *  an article the answer merely linked to. */
function webSpans(text: string): Map<string, TextSpan> {
  const spans = new Map<string, TextSpan>();
  for (const match of text.matchAll(WEB_URL)) {
    const raw = trimUrlTail(match[0]);
    const identity = normalizeWebIdentity(raw);
    if (!identity || spans.has(identity)) continue;
    spans.set(identity, { start: match.index ?? 0, length: raw.length });
  }
  return spans;
}

function startsPath(text: string, start: number): boolean {
  const before = text[start - 1];
  if (before === undefined || !PATH_CHAR.test(before)) return true;
  // `./report.md` names the file the registry stored without the prefix.
  if (before !== "/" || text[start - 2] !== ".") return false;
  const earlier = text[start - 3];
  return earlier === undefined || !PATH_CHAR.test(earlier);
}

function endsPath(text: string, end: number): boolean {
  const next = text[end];
  if (next === undefined || !PATH_CHAR.test(next)) return true;
  // A period closes the sentence unless a longer name continues after it.
  if (next !== ".") return false;
  const after = text[end + 1];
  return after === undefined || after === "." || !PATH_CHAR.test(after);
}

/** A captured path only cites the text that writes it as a whole token:
 *  `report.md` must not claim `report.md.bak`, and `data/report.md` is
 *  another file. */
function fileSpan(text: string, identity: string): TextSpan | null {
  for (let start = text.indexOf(identity); start >= 0; start = text.indexOf(identity, start + 1)) {
    if (startsPath(text, start) && endsPath(text, start + identity.length)) return { start, length: identity.length };
  }
  return null;
}

/** Resolve the identifiers and captured sources an answer text mentions.
 *  A path or URL only becomes a citation when the server captured it, so a
 *  fabricated path in the prose can never render as a source. */
export function resolveCitations(text: string, sources: CitationSource[]): ResolvedCitation[] {
  const lowered = text.toLowerCase();
  const tokens: CitationToken[] = [];
  for (const citation of extractCitations(text)) {
    const start = lowered.indexOf(citation.id);
    if (start < 0) continue;
    tokens.push({ kind: citation.kind, identity: citation.id, start, end: start + citation.id.length });
  }
  const identifierStarts = new Set(tokens.map((token) => token.start));
  const web = webSpans(text);
  const byKey = new Map<string, CitationSource>();
  for (const source of sources) {
    byKey.set(`${source.kind}:${source.identity}`, source);
    if (IDENTIFIER_KINDS.includes(source.kind)) continue;
    const span = source.kind === "web" ? web.get(source.identity) : fileSpan(text, source.identity);
    // An identifier already claimed this offset: `10.1234/x` is not a path.
    if (!span || identifierStarts.has(span.start)) continue;
    tokens.push({ kind: source.kind, identity: source.identity, start: span.start, end: span.start + span.length });
  }
  const seen = new Set<string>();
  return tokens
    .sort((left, right) => left.start - right.start || Number(IDENTIFIER_KINDS.includes(right.kind)) - Number(IDENTIFIER_KINDS.includes(left.kind)))
    .flatMap((token) => {
      const key = `${token.kind}:${token.identity}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ index: seen.size, token, source: byKey.get(key) ?? null }];
    });
}
