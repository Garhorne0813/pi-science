export interface SheetHtml {
  name: string;
  html: string;
  truncated: boolean;
}

const MAX_ROWS = 600;
const MAX_COLUMNS = 80;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cellPosition(value: string): { row: number; column: number } | null {
  const match = /^([A-Z]+)(\d+)$/i.exec(value);
  if (!match) return null;
  let column = 0;
  for (const char of match[1].toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64;
  return { row: Number(match[2]), column };
}

function cellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toLocaleString();
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.richText)) {
      return record.richText.map((part) => String((part as Record<string, unknown>).text ?? "")).join("");
    }
    if ("result" in record) return String(record.result ?? "");
    if ("text" in record) return String(record.text ?? "");
    if ("hyperlink" in record) return String(record.text ?? record.hyperlink ?? "");
  }
  return String(value);
}

function argbToCss(color: unknown): string | undefined {
  if (!color || typeof color !== "object") return undefined;
  const argb = String((color as Record<string, unknown>).argb ?? "");
  if (!/^[0-9a-f]{8}$/i.test(argb)) return undefined;
  return `#${argb.slice(2)}`;
}

function cellStyle(cell: any): string {
  const styles: string[] = [];
  if (cell.font?.bold) styles.push("font-weight:700");
  if (cell.font?.italic) styles.push("font-style:italic");
  if (cell.font?.size) styles.push(`font-size:${Math.max(8, Number(cell.font.size))}px`);
  const fontColor = argbToCss(cell.font?.color);
  const fillColor = argbToCss(cell.fill?.fgColor);
  if (fontColor) styles.push(`color:${fontColor}`);
  if (fillColor) styles.push(`background-color:${fillColor}`);
  if (cell.alignment?.horizontal) styles.push(`text-align:${cell.alignment.horizontal}`);
  if (cell.alignment?.vertical) styles.push(`vertical-align:${cell.alignment.vertical}`);
  return styles.join(";");
}

function mergeMap(worksheet: any): Map<string, { rowspan: number; colspan: number }> {
  const result = new Map<string, { rowspan: number; colspan: number }>();
  const merges = Array.isArray(worksheet.model?.merges) ? worksheet.model.merges : [];
  for (const range of merges) {
    const [start, end] = String(range).split(":");
    const a = cellPosition(start);
    const b = cellPosition(end);
    if (!a || !b) continue;
    result.set(`${a.row}:${a.column}`, {
      rowspan: Math.max(1, b.row - a.row + 1),
      colspan: Math.max(1, b.column - a.column + 1),
    });
    for (let row = a.row; row <= b.row; row++) {
      for (let column = a.column; column <= b.column; column++) {
        if (row !== a.row || column !== a.column) result.set(`${row}:${column}`, { rowspan: 0, colspan: 0 });
      }
    }
  }
  return result;
}

function renderSheet(worksheet: any): SheetHtml {
  const rows = Math.min(Math.max(worksheet.rowCount || 1, 1), MAX_ROWS);
  const columns = Math.min(Math.max(worksheet.columnCount || 1, 1), MAX_COLUMNS);
  const merges = mergeMap(worksheet);
  const html: string[] = ["<table><colgroup>"];
  for (let column = 1; column <= columns; column++) {
    const width = Number(worksheet.getColumn(column).width || 12);
    html.push(`<col style="width:${Math.min(Math.max(width * 8, 48), 360)}px">`);
  }
  html.push("</colgroup><tbody>");
  for (let row = 1; row <= rows; row++) {
    html.push("<tr>");
    for (let column = 1; column <= columns; column++) {
      const merge = merges.get(`${row}:${column}`);
      if (merge?.rowspan === 0) continue;
      const cell = worksheet.getCell(row, column);
      const attrs = [
        cellStyle(cell) ? ` style="${escapeHtml(cellStyle(cell))}"` : "",
        merge && merge.rowspan > 1 ? ` rowspan="${merge.rowspan}"` : "",
        merge && merge.colspan > 1 ? ` colspan="${merge.colspan}"` : "",
      ].join("");
      html.push(`<td${attrs}>${escapeHtml(cellValue(cell.value))}</td>`);
    }
    html.push("</tr>");
  }
  html.push("</tbody></table>");
  return {
    name: String(worksheet.name || `Sheet${worksheet.id}`),
    html: html.join(""),
    truncated: (worksheet.rowCount || 0) > MAX_ROWS || (worksheet.columnCount || 0) > MAX_COLUMNS,
  };
}

/** Parse an XLSX workbook into lightweight, style-aware HTML sheets. */
export async function workbookSheets(bytes: ArrayBuffer): Promise<SheetHtml[]> {
  const { Workbook } = await import("exceljs");
  const workbook = new Workbook();
  await workbook.xlsx.load(bytes);
  return workbook.worksheets.map((worksheet) => renderSheet(worksheet));
}

// Kept for compatibility with older callers.
export async function renderXlsx(bytes: ArrayBuffer): Promise<HTMLElement> {
  const root = document.createElement("div");
  const sheets = await workbookSheets(bytes);
  root.innerHTML = sheets[0]?.html || "";
  return root;
}
