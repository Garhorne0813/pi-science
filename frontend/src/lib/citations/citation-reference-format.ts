import type { CitationEvidence } from "./citation-evidence";

/** The fields a formatted reference can be built from. Every one of them may be
 *  missing; a missing field is left out rather than printed as a placeholder,
 *  because a formatted reference that invents a volume is worse than a short
 *  one. */
export type CitationReferenceFields = Pick<CitationEvidence, "kind" | "id" | "title" | "authors" | "journal" | "year" | "volume" | "issue" | "pages">;

function authorLine(fields: CitationReferenceFields, join: (names: string[]) => string): string | null {
  const names = fields.authors.filter((name) => name.trim());
  return names.length ? join(names) : null;
}

/** The record's own locator. Both forms are the identifier the citation
 *  already names, so neither is an invented field. */
function locator(fields: CitationReferenceFields): string {
  return fields.kind === "doi" ? `DOI: ${fields.id}` : `https://arxiv.org/abs/${fields.id}`;
}

/** `12(3)` from whatever of volume and issue exists, so a record that has only
 *  one of them prints only that one. */
function serialNumber(fields: CitationReferenceFields): string | null {
  if (fields.volume) return fields.issue ? `${fields.volume}(${fields.issue})` : fields.volume;
  return fields.issue;
}

/** GB/T 7714 puts up to three responsible persons, then "et al". The record
 *  holds display names, not the surname-initials form the standard asks for,
 *  so the names are used as they were recorded. */
function gbtAuthors(names: string[]): string {
  return names.length > 3 ? `${names.slice(0, 3).join(", ")}, et al` : names.join(", ");
}

function gbt(fields: CitationReferenceFields): string | null {
  // A record with a journal is a journal article; without one it is an online
  // record (an arXiv preprint), which is what the standard's marker says.
  const type = fields.journal ? "[J]" : "[EB/OL]";
  const source = [fields.journal, fields.year, serialNumber(fields), fields.pages].filter((part): part is string => Boolean(part));
  const parts = [
    authorLine(fields, gbtAuthors),
    fields.title ? `${fields.title}${type}` : null,
    source.length ? source.join(", ") : null,
    locator(fields),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 1 ? `${parts.join(". ")}.` : null;
}

/** APA 7 initials: the last token is the family name and the tokens before it
 *  are given names. A one-token name has no initials to add, so it stays as
 *  written. */
function apaName(name: string): string {
  const tokens = name.trim().split(/\s+/);
  if (tokens.length < 2) return tokens[0] ?? "";
  const family = tokens[tokens.length - 1]!;
  const initials = tokens.slice(0, -1).map((token) => `${token[0]!.toUpperCase()}.`).join(" ");
  return `${family}, ${initials}`;
}

/** APA 7 lists up to twenty authors, then the first nineteen, an ellipsis and
 *  the last. */
function apaAuthors(names: string[]): string {
  const formatted = names.map(apaName);
  if (formatted.length === 1) return formatted[0]!;
  const listed = formatted.length > 20 ? [...formatted.slice(0, 19), "…", formatted[formatted.length - 1]!] : formatted;
  return `${listed.slice(0, -1).join(", ")}, & ${listed[listed.length - 1]!}`;
}

function apa(fields: CitationReferenceFields): string | null {
  const author = authorLine(fields, apaAuthors);
  const serial = serialNumber(fields);
  const source = [fields.journal, serial ? `${serial}${fields.pages ? `, ${fields.pages}` : ""}` : fields.pages].filter((part): part is string => Boolean(part));
  const parts = [
    // The initials already end in a period; one more would read as two.
    author ? `${author.replace(/[.]$/, "")}.` : null,
    fields.year ? `(${fields.year}).` : null,
    fields.title ? `${fields.title.replace(/[.]$/, "")}.` : null,
    source.length ? `${source.join(", ")}.` : null,
    fields.kind === "doi" ? `https://doi.org/${fields.id}` : locator(fields),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 1 ? parts.join(" ") : null;
}

/** The same record written the way a Chinese GB/T 7714 list and an APA list
 *  write it, or null when the record holds nothing to cite beyond its
 *  identifier. */
export function formattedReference(fields: CitationReferenceFields, style: "gbt7714" | "apa"): string | null {
  return style === "gbt7714" ? gbt(fields) : apa(fields);
}
