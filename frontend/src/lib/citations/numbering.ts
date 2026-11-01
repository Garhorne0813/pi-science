import { scanCitations, type Citation } from "./citations";

/** One cited source inside one document version, carrying the number that
 *  version gives it. Numbering is presentation, not identity: `id` stays the
 *  version-less source key, and every spelling the document used is kept so a
 *  reader can see which arXiv version was cited. */
export interface CitationSource {
  /** 1-based, in first-citation order. */
  number: number;
  kind: Citation["kind"];
  id: string;
  /** Distinct spellings of this source in the document, first-seen order. */
  requested_ids: string[];
  /** First arXiv version cited, digits only, or null. */
  requested_version: string | null;
  /** Resolver for the first cited spelling. */
  url: string;
}

export interface CitationNumbering { sources: CitationSource[] }

/** An entry's bibliographic part, when it is known. Fields a caller does not
 *  know stay absent rather than being guessed. */
export interface CitationReferenceDetail {
  title?: string | null;
  authors?: readonly string[] | null;
  year?: string | null;
  venue?: string | null;
  url?: string | null;
}

export interface ReferenceOptions {
  /** Heading for the list. Defaults to `References`. */
  heading?: string;
  details?: ReadonlyMap<number, CitationReferenceDetail>;
}

const REFERENCES_HEADING = /(?:^|\n)#{1,6}[ \t]*references[ \t]*\n/i;

/** Number the citations of one document version. The same source cited twice
 *  keeps one number, because the order is decided by where a source first
 *  appears and by nothing else. Two versions of one answer produce their own
 *  numbering from their own text, so a regenerated answer can never inherit
 *  the previous answer's numbers. */
export function numberCitations(markdown: string): CitationNumbering {
  const bySource = new Map<string, CitationSource>();
  for (const occurrence of scanCitations(markdown)) {
    const key = `${occurrence.kind}:${occurrence.id}`;
    const existing = bySource.get(key);
    if (!existing) {
      bySource.set(key, { number: bySource.size + 1, kind: occurrence.kind, id: occurrence.id, requested_ids: [occurrence.requested_id], requested_version: occurrence.requested_version, url: occurrence.url });
      continue;
    }
    if (!existing.requested_ids.includes(occurrence.requested_id)) existing.requested_ids.push(occurrence.requested_id);
    existing.requested_version ??= occurrence.requested_version;
  }
  return { sources: [...bySource.values()] };
}

export function citationNumberOf(numbering: CitationNumbering, kind: Citation["kind"], id: string): number | null {
  return numbering.sources.find((source) => source.kind === kind && source.id === id)?.number ?? null;
}

/** Resolve the number for a `kind:requestedId` key, the form the renderer and
 *  the evidence lookup carry, so a body marker and the reference list can never
 *  disagree about which source they mean. */
export function citationNumberForKey(numbering: CitationNumbering, key: string): number | null {
  const separator = key.indexOf(":");
  if (separator === -1) return null;
  const kind = key.slice(0, separator);
  const requestedId = key.slice(separator + 1);
  return numbering.sources.find((source) => source.kind === kind && source.requested_ids.includes(requestedId))?.number ?? null;
}

function authorLine(authors: readonly string[] | null | undefined): string | null {
  if (!authors?.length) return null;
  return authors.length > 3 ? `${authors.slice(0, 3).join(", ")}, et al.` : authors.join(", ");
}

function referenceLine(source: CitationSource, detail: CitationReferenceDetail | undefined): string {
  const author = authorLine(detail?.authors);
  const year = detail?.year ? `(${detail.year})` : null;
  const head = [author, year].filter(Boolean).join(" ");
  const body = [head || null, detail?.title ?? null, detail?.venue ?? null].filter(Boolean).join(". ");
  const link = detail?.url ?? source.url;
  return `[${source.number}] ${body ? `${body}. ` : ""}${source.requested_ids.join(", ")} — ${link}`;
}

/** The numbered reference list as plain text, for a copied answer and for a
 *  generated report file. A field nobody looked up is left out; the entry then
 *  falls back to the identifier and its resolver instead of a made-up title. */
export function referencesText(numbering: CitationNumbering, options: ReferenceOptions = {}): string {
  const heading = options.heading ?? "References";
  const lines = numbering.sources.map((source) => referenceLine(source, options.details?.get(source.number)));
  return [`## ${heading}`, ...lines].join("\n");
}

/** Where a marker goes: after the identifier, and after a closing bracket or
 *  CJK closer that wraps it, so `(10.1000/alpha)` reads `(10.1000/alpha)[1]`. */
const CLOSER = /[)\]}\u300d\u300f\u3011\uff09\uff3d\u201d]/;

function markerOffset(body: string, end: number): number {
  let at = end;
  while (at < body.length && CLOSER.test(body[at]!)) at += 1;
  return at;
}

/** Body markers plus the reference list, so what a reader copies or opens from
 *  disk carries the same numbering as the screen. A marker is inserted only
 *  where it is missing, which keeps a document that already carries one from
 *  growing a second, and a document that already ends in a reference list from
 *  stacking another. */
export function withReferences(markdown: string, options: ReferenceOptions = {}): string {
  const numbering = numberCitations(markdown);
  if (!numbering.sources.length) return markdown;
  const headingAt = markdown.search(REFERENCES_HEADING);
  const body = headingAt === -1 ? markdown : markdown.slice(0, headingAt);
  let out = body;
  const insertions = scanCitations(body).flatMap((occurrence) => {
    const number = citationNumberOf(numbering, occurrence.kind, occurrence.id);
    if (number === null) return [];
    const at = markerOffset(body, occurrence.end);
    return body.startsWith(`[${number}]`, at) ? [] : [{ at, marker: `[${number}]` }];
  });
  for (const { at, marker } of insertions.sort((left, right) => right.at - left.at)) out = `${out.slice(0, at)}${marker}${out.slice(at)}`;
  return `${out.trimEnd()}\n\n${referencesText(numbering, options)}\n`;
}
