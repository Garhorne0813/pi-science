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
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  url?: string | null;
}

export interface ReferenceOptions {
  /** Heading for the list. Defaults to `References`. */
  heading?: string;
  details?: ReadonlyMap<number, CitationReferenceDetail>;
}

/** A heading that starts a reference list. Both the English and the Chinese
 *  headings are recognised, because an answer written in Chinese uses the
 *  second and a rule that only knew the first appended a duplicate list. */
const REFERENCE_HEADING = /^(#{1,6})[ \t]+(?:references|bibliography|works cited|参考文献|引用文献|参考书目)[ \t]*:?[ \t]*$/i;
const HEADING_LINE = /^(#{1,6})[ \t]+\S/;
const ENTRY_LINE = /^([ \t]*)(?:\[(\d{1,3})\]|\d{1,3}[.)、]|[-*•])[ \t]+(.*)$/;

export interface ReferenceSection {
  /** Offset of the heading line. */
  start: number;
  /** Offset where the section stops: the next heading of the same or a higher
   *  level, or the end of the document. */
  end: number;
  level: number;
}

function lineSpans(markdown: string): Array<{ text: string; start: number; end: number }> {
  const spans: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  for (;;) {
    const newline = markdown.indexOf("\n", start);
    const end = newline === -1 ? markdown.length : newline;
    spans.push({ text: markdown.slice(start, end), start, end });
    if (newline === -1) return spans;
    start = newline + 1;
  }
}

/** Every reference list in the document. A source that appears only in one of
 *  these is a bibliography entry the answer printed, not a place the answer
 *  cited it, so it must not take a body number: guessing which sentence it
 *  belongs to would invent a link the document never made. */
export function referenceSections(markdown: string): ReferenceSection[] {
  const spans = lineSpans(markdown);
  const sections: ReferenceSection[] = [];
  for (let index = 0; index < spans.length; index += 1) {
    const heading = REFERENCE_HEADING.exec(spans[index]!.text);
    if (!heading) continue;
    const level = heading[1]!.length;
    let end = markdown.length;
    let resume = spans.length;
    for (let next = index + 1; next < spans.length; next += 1) {
      const other = HEADING_LINE.exec(spans[next]!.text);
      if (other && other[1]!.length <= level) { end = spans[next]!.start; resume = next; break; }
    }
    sections.push({ start: spans[index]!.start, end, level });
    index = resume - 1;
  }
  return sections;
}

function blankReferenceSection(markdown: string): string {
  const chars = markdown.split("");
  for (const section of referenceSections(markdown)) {
    for (let index = section.start; index < section.end; index += 1) if (chars[index] !== "\n") chars[index] = " ";
  }
  return chars.join("");
}

function numberFor(numbering: CitationNumbering, kind: Citation["kind"], requestedId: string): number | null {
  return numbering.sources.find((source) => source.kind === kind && source.requested_ids.includes(requestedId))?.number ?? null;
}

/** Number the citations of one document version. The same source cited twice
 *  keeps one number, because the order is decided by where a source first
 *  appears and by nothing else. Two versions of one answer produce their own
 *  numbering from their own text, so a regenerated answer can never inherit
 *  the previous answer's numbers. */
export function numberCitations(markdown: string): CitationNumbering {
  const body = blankReferenceSection(markdown);
  const bySource = new Map<string, CitationSource>();
  for (const occurrence of scanCitations(body)) {
    const key = `${occurrence.kind}:${occurrence.requested_id}`;
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
  return numbering.sources.find((source) => source.kind === kind && (source.id === id || source.requested_ids.includes(id)))?.number ?? null;
}

/** Resolve the number for a `kind:requestedId` key, the form the renderer and
 *  the evidence lookup carry, so a body marker and the reference list can never
 *  disagree about which source they mean. An arXiv key carries the version the
 *  answer cited, so v1 and v2 resolve to their own numbers. */
export function citationNumberForKey(numbering: CitationNumbering, key: string): number | null {
  const separator = key.indexOf(":");
  if (separator === -1) return null;
  const kind = key.slice(0, separator);
  const requestedId = key.slice(separator + 1);
  return numbering.sources.find((source) => source.kind === kind && (source.requested_ids.includes(requestedId) || source.id === requestedId))?.number ?? null;
}

function authorLine(authors: readonly string[] | null | undefined): string | null {
  if (!authors?.length) return null;
  return authors.length > 3 ? `${authors.slice(0, 3).join(", ")}, et al.` : authors.join(", ");
}

function referenceLine(source: CitationSource, detail: CitationReferenceDetail | undefined): string {
  const author = authorLine(detail?.authors);
  const year = detail?.year ? `(${detail.year})` : null;
  const head = [author, year].filter(Boolean).join(" ");
  const volume = detail?.volume ? [`${detail.volume}${detail.issue ? `(${detail.issue})` : ""}`, detail.pages].filter(Boolean).join(": ") : detail?.pages ?? null;
  const body = [head || null, detail?.title ?? null, detail?.venue ?? null, volume].filter(Boolean).join(". ");
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

function withinReferenceList(at: number, sections: ReferenceSection[]): boolean {
  return sections.some((section) => at >= section.start && at < section.end);
}

/** Body markers plus the reference list, so what a reader copies or opens
 *  from disk carries the same numbering as the screen. A marker is inserted
 *  only where it is missing, so a document that already carries one does not
 *  grow a second. Every existing character stays where it was: an entry the
 *  answer wrote keeps its authors, title and year, and a section printed after
 *  the list survives. */
export function withReferences(markdown: string, options: ReferenceOptions = {}): string {
  const numbering = numberCitations(markdown);
  if (!numbering.sources.length) return markdown;
  const sections = referenceSections(markdown);
  const insertions = scanCitations(markdown).flatMap((occurrence) => {
    if (withinReferenceList(occurrence.start, sections)) return [];
    const number = numberFor(numbering, occurrence.kind, occurrence.requested_id);
    if (number === null) return [];
    const at = markerOffset(markdown, occurrence.end);
    return markdown.startsWith(`[${number}]`, at) ? [] : [{ at, marker: `[${number}]` }];
  });
  let out = markdown;
  for (const { at, marker } of insertions.sort((left, right) => right.at - left.at)) out = `${out.slice(0, at)}${marker}${out.slice(at)}`;
  const shifted = referenceSections(out);
  return shifted.length ? rewriteReferenceLists(out, shifted, numbering, options) : `${out.trimEnd()}\n\n${referencesText(numbering, options)}\n`;
}

/** Give every entry in an existing list the number the body gave its source,
 *  and append an entry for a source the list forgot. An entry that names no
 *  source the body cites is left exactly as written: it may be a note rather
 *  than a bibliography line, and dropping it would lose the answer's own text. */
function rewriteReferenceLists(markdown: string, sections: ReferenceSection[], numbering: CitationNumbering, options: ReferenceOptions): string {
  let out = markdown;
  for (const section of [...sections].reverse()) out = rewriteReferenceList(out, section, numbering, options);
  return out;
}

function rewriteReferenceList(markdown: string, section: ReferenceSection, numbering: CitationNumbering, options: ReferenceOptions): string {
  const covered = new Set<number>();
  const rewritten = markdown.slice(section.start, section.end).split("\n").map((line) => {
    const entry = ENTRY_LINE.exec(line);
    if (!entry) return line;
    const [, indent = "", , rest = ""] = entry;
    const source = scanCitations(rest)[0];
    if (!source) return line;
    const number = numberFor(numbering, source.kind, source.requested_id);
    if (number === null) return line;
    covered.add(number);
    return `${indent}[${number}] ${rest}`;
  }).join("\n");
  const missing = numbering.sources.filter((source) => !covered.has(source.number));
  const atDocumentEnd = section.end >= markdown.length;
  const tail = missing.length ? `${rewritten.replace(/\s*$/, "")}\n${missing.map((source) => referenceLine(source, options.details?.get(source.number))).join("\n")}${atDocumentEnd ? "" : "\n\n"}` : rewritten;
  return `${markdown.slice(0, section.start)}${tail}${markdown.slice(section.end)}`;
}
