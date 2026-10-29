/**
 * Structured diffs between two published artifact versions.
 *
 * Text and code produce unified hunks (a bounded LCS over lines), CSV/TSV
 * additionally produce cell-level changes on top of the aligned rows, images
 * return the two immutable content hashes for side-by-side rendering, and
 * everything else reports itself as unsupported rather than guessing.
 */
import { resolveArtifactContent } from "./artifact-content-store.js";

export interface DiffLine {
  type: " " | "-" | "+";
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export type ArtifactDiff =
  | {
      kind: "text";
      from_version: number;
      to_version: number;
      hunks: DiffHunk[];
      from_lines: number;
      to_lines: number;
      truncated: boolean;
    }
  | {
      kind: "table";
      from_version: number;
      to_version: number;
      delimiter: string;
      rows_added: number;
      rows_removed: number;
      cells: Array<{ row: number; column: string; from: string; to: string }>;
      hunks: DiffHunk[];
      truncated: boolean;
      /** Set when quoted fields could not be parsed, so only row-level hunks are reported. */
      cells_unavailable?: "unbalanced_quotes";
    }
  | {
      kind: "image";
      from_version: number;
      to_version: number;
      from_sha256: string;
      to_sha256: string;
    }
  | {
      kind: "unsupported";
      from_version: number;
      to_version: number;
      reason: string;
    };

export interface DiffableManifest {
  artifact_id: string;
  version: number;
  path: string;
  mime: string;
  sha256: string;
}

const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_LINES = 3_000;
const MAX_DIFF_CELLS = 500;
const HUNK_CONTEXT_LINES = 3;

const TEXT_EXTENSIONS = new Set([
  "md", "txt", "json", "yaml", "yml", "py", "r", "jl", "sh", "bash", "tex", "html", "htm",
  "js", "ts", "mjs", "cjs", "css", "xml", "toml", "ini", "cfg", "log", "csv", "tsv", "bed", "gff", "gtf",
]);

function extensionOf(path: string): string {
  const parts = path.split("/");
  const name = parts.at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function diffKindFor(manifest: DiffableManifest): "text" | "table" | "image" | "unsupported" {
  const ext = extensionOf(manifest.path);
  if (manifest.mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tif", "tiff"].includes(ext)) return "image";
  if (ext === "csv" || ext === "tsv") return "table";
  if (manifest.mime.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) return "text";
  return "unsupported";
}

async function readVersionBytes(cwd: string, manifest: DiffableManifest): Promise<Buffer> {
  const resolved = await resolveArtifactContent(cwd, manifest.path, manifest.sha256);
  try {
    if (resolved.size > MAX_DIFF_BYTES) throw new Error("version is too large to diff");
    const buffer = Buffer.alloc(resolved.size);
    await resolved.handle.read(buffer, 0, resolved.size, 0);
    return buffer;
  } finally {
    await resolved.handle.close();
  }
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Classic LCS table diff, bounded to MAX_DIFF_LINES per side. */
function lineDiff(fromLines: string[], toLines: string[]): { lines: DiffLine[]; truncated: boolean } {
  const truncated = fromLines.length > MAX_DIFF_LINES || toLines.length > MAX_DIFF_LINES;
  const from = fromLines.slice(0, MAX_DIFF_LINES);
  const to = toLines.slice(0, MAX_DIFF_LINES);
  const width = to.length + 1;
  // Two rolling rows are enough to backtrack-free forward diffing; we then
  // rebuild the path with a divide-free walk using the full table stored as
  // previous-row deltas is avoided by re-running: simplicity over memory.
  const table = new Uint32Array((from.length + 1) * width);
  for (let i = from.length - 1; i >= 0; i -= 1) {
    for (let j = to.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = from[i] === to[j]
        ? table[(i + 1) * width + (j + 1)]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + (j + 1)]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < from.length && j < to.length) {
    if (from[i] === to[j]) { lines.push({ type: " ", text: from[i]! }); i += 1; j += 1; }
    else if (table[(i + 1) * width + j]! >= table[i * width + (j + 1)]!) { lines.push({ type: "-", text: from[i]! }); i += 1; }
    else { lines.push({ type: "+", text: to[j]! }); j += 1; }
  }
  while (i < from.length) { lines.push({ type: "-", text: from[i]! }); i += 1; }
  while (j < to.length) { lines.push({ type: "+", text: to[j]! }); j += 1; }
  return { lines, truncated };
}

/** Compress a full line diff into hunks with bounded context. */
function toHunks(lines: DiffLine[]): DiffHunk[] {
  const changed = lines.map((line) => line.type !== " ");
  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!changed[index]) { index += 1; continue; }
    const start = Math.max(0, index - HUNK_CONTEXT_LINES);
    let end = index;
    let lastChange = index;
    while (end < lines.length && (changed[end] || end - lastChange <= HUNK_CONTEXT_LINES)) {
      if (changed[end]) lastChange = end;
      end += 1;
    }
    end = Math.min(lines.length, end + HUNK_CONTEXT_LINES);
    // Recount from/to positions for the header.
    let fromStart = 1;
    let toStart = 1;
    for (let k = 0; k < start; k += 1) {
      if (lines[k]!.type !== "+") fromStart += 1;
      if (lines[k]!.type !== "-") toStart += 1;
    }
    let fromCount = 0;
    let toCount = 0;
    for (let k = start; k < end; k += 1) {
      if (lines[k]!.type !== "+") fromCount += 1;
      if (lines[k]!.type !== "-") toCount += 1;
    }
    hunks.push({
      header: `@@ -${fromStart},${fromCount} +${toStart},${toCount} @@`,
      lines: lines.slice(start, end),
    });
    index = end;
  }
  return hunks;
}

/** Split a delimited table into records, honouring RFC 4180 quoting: a quoted
 *  field may hold the delimiter, a line break, or a doubled quote. Returns null
 *  when a quote never closes, because the rows cannot be recovered without
 *  guessing; the caller then reports the row-level line diff alone. */
function parseDelimitedRecords(text: string, delimiter: string): string[][] | null {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = false;
      continue;
    }
    if (ch === '"' && field === "") { quoted = true; continue; }
    if (ch === delimiter) { record.push(field); field = ""; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      continue;
    }
    field += ch;
  }
  if (quoted) return null;
  if (field !== "" || record.length > 0) { record.push(field); records.push(record); }
  return records;
}

/** Cell-level changes for aligned replacement blocks of a parsed table. Rows are
 *  aligned by record content, so one quoted field holding the delimiter or a
 *  line break stays one cell on one row. */
function tableCells(fromRecords: string[][], toRecords: string[][]): { cells: Array<{ row: number; column: string; from: string; to: string }>; rowsAdded: number; rowsRemoved: number; truncated: boolean } {
  const cells: Array<{ row: number; column: string; from: string; to: string }> = [];
  let rowsAdded = 0;
  let rowsRemoved = 0;
  // Pair consecutive -/+ runs and compare per column; the first row supplies headers.
  const headers = fromRecords[0] ?? [];
  const rowKey = (record: string[]) => JSON.stringify(record);
  const recordsByKey = new Map<string, string[]>([...fromRecords, ...toRecords].map((record) => [rowKey(record), record]));
  const { lines, truncated } = lineDiff(fromRecords.map(rowKey), toRecords.map(rowKey));
  let index = 0;
  let rowNumber = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.type === " ") { rowNumber += 1; index += 1; continue; }
    if (line.type === "-") {
      const removed: string[] = [];
      while (index < lines.length && lines[index]!.type === "-") { removed.push(lines[index]!.text); index += 1; }
      const added: string[] = [];
      while (index < lines.length && lines[index]!.type === "+") { added.push(lines[index]!.text); index += 1; }
      rowsRemoved += removed.length - Math.min(removed.length, added.length);
      rowsAdded += added.length - Math.min(removed.length, added.length);
      for (let k = 0; k < Math.min(removed.length, added.length); k += 1) {
        const fromCells = recordsByKey.get(removed[k]!) ?? [];
        const toCells = recordsByKey.get(added[k]!) ?? [];
        for (let column = 0; column < Math.max(fromCells.length, toCells.length); column += 1) {
          const from = fromCells[column] ?? "";
          const to = toCells[column] ?? "";
          if (from === to) continue;
          if (cells.length >= MAX_DIFF_CELLS) return { cells, rowsAdded, rowsRemoved, truncated: true };
          cells.push({ row: rowNumber + k + 1, column: headers[column] ?? `#${column + 1}`, from, to });
        }
      }
      rowNumber += Math.max(removed.length, added.length);
      continue;
    }
    if (line.type === "+") {
      let addedCount = 0;
      while (index < lines.length && lines[index]!.type === "+") { addedCount += 1; index += 1; }
      rowsAdded += addedCount;
      rowNumber += addedCount;
      continue;
    }
    index += 1;
  }
  return { cells, rowsAdded, rowsRemoved, truncated };
}

export async function diffArtifactVersions(cwd: string, from: DiffableManifest, to: DiffableManifest): Promise<ArtifactDiff> {
  const kind = diffKindFor(to);
  if (kind === "unsupported") {
    return { kind: "unsupported", from_version: from.version, to_version: to.version, reason: "diffing is provided for text, tables and images" };
  }
  if (kind === "image") {
    return { kind: "image", from_version: from.version, to_version: to.version, from_sha256: from.sha256, to_sha256: to.sha256 };
  }
  let fromText: string;
  let toText: string;
  try {
    const buffers = [await readVersionBytes(cwd, from), await readVersionBytes(cwd, to)];
    fromText = buffers[0]!.toString("utf8");
    toText = buffers[1]!.toString("utf8");
  } catch (error) {
    return { kind: "unsupported", from_version: from.version, to_version: to.version, reason: error instanceof Error ? error.message : String(error) };
  }
  const fromLines = splitLines(fromText);
  const toLines = splitLines(toText);
  const { lines, truncated } = lineDiff(fromLines, toLines);
  const hunks = toHunks(lines);
  if (kind === "table") {
    const delimiter = extensionOf(to.path) === "tsv" ? "\t" : ",";
    const fromRecords = parseDelimitedRecords(fromText, delimiter);
    const toRecords = parseDelimitedRecords(toText, delimiter);
    const table = fromRecords && toRecords ? tableCells(fromRecords, toRecords) : null;
    return {
      kind: "table",
      from_version: from.version,
      to_version: to.version,
      delimiter,
      rows_added: table?.rowsAdded ?? 0,
      rows_removed: table?.rowsRemoved ?? 0,
      cells: table?.cells ?? [],
      ...(table ? {} : { cells_unavailable: "unbalanced_quotes" as const }),
      hunks,
      truncated: truncated || (table?.truncated ?? false),
    };
  }
  return { kind: "text", from_version: from.version, to_version: to.version, hunks, from_lines: fromLines.length, to_lines: toLines.length, truncated };
}
