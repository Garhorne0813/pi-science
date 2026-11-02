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

const IDENTIFIER_KINDS: CitationSourceKind[] = ["doi", "arxiv"];

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
  const byKey = new Map<string, CitationSource>();
  for (const source of sources) {
    byKey.set(`${source.kind}:${source.identity}`, source);
    if (IDENTIFIER_KINDS.includes(source.kind)) continue;
    const start = text.indexOf(source.identity);
    // An identifier already claimed this offset: `10.1234/x` is not a path.
    if (start < 0 || identifierStarts.has(start)) continue;
    tokens.push({ kind: source.kind, identity: source.identity, start, end: start + source.identity.length });
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
