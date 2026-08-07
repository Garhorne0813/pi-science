/** Snippet parsers for per-turn artifact cards (Claude Science style content
 *  previews). Pure functions: given the capped file text they return a small
 *  renderable slice (mini table, code lines, markdown excerpt). */

export interface CsvSnippet {
  columns: string[];
  rows: string[][];
  /** True when more rows exist beyond the parsed window. */
  truncated: boolean;
}

const MAX_ROWS = 4;
const MAX_COLS = 5;

/** Split one CSV/TSV line into fields with simple quote handling (double
 *  quotes wrap fields; a doubled quote is an escaped quote; separators inside
 *  quotes do not split). Kept deliberately simple — snippets only. */
export function splitDelimitedLine(line: string, separator: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === separator && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function parseDelimited(text: string, separator: string): CsvSnippet {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const slice = lines.slice(0, MAX_ROWS);
  const rows = slice.map((line) => splitDelimitedLine(line, separator).slice(0, MAX_COLS));
  const columns = rows[0] ?? [];
  return { columns, rows: rows.slice(1), truncated: lines.length > MAX_ROWS };
}

export function parseCsvSnippet(text: string): CsvSnippet {
  return parseDelimited(text, ",");
}

export function parseTsvSnippet(text: string): CsvSnippet {
  return parseDelimited(text, "\t");
}

/** First N lines of a code-like file, joined for a monospace preview. */
export function codeSnippet(text: string, maxLines = 8): { code: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  return { code: lines.slice(0, maxLines).join("\n"), truncated: lines.length > maxLines };
}

/** First ~200 characters of markdown, cut at a word boundary. */
export function markdownSnippet(text: string, maxChars = 200): { markdown: string; truncated: boolean } {
  if (text.length <= maxChars) return { markdown: text, truncated: false };
  const cut = text.slice(0, maxChars);
  const boundary = cut.lastIndexOf(" ");
  return { markdown: boundary > 40 ? cut.slice(0, boundary) : cut, truncated: true };
}
