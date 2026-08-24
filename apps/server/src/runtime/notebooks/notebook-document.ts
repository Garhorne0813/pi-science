import { createHash, randomUUID } from "node:crypto";

export interface NotebookCellDocument {
  [key: string]: unknown;
  id?: string;
  cell_type?: string;
  source?: string | string[];
  execution_count?: number | null;
  outputs?: unknown[];
}

export interface NotebookDocument {
  [key: string]: unknown;
  cells: NotebookCellDocument[];
}

export type NotebookEditOperation =
  | { cell_id: string; action: "replace_source"; source: string; cell_type?: string }
  | { cell_id: string; action: "clear_outputs" }
  | { action: "insert_cell"; source: string; cell_type: string; cell_id?: string; before_cell_id?: string }
  | { cell_id: string; action: "delete_cell" };

export interface AppliedNotebookEdits {
  document: NotebookDocument;
  changed_cell_ids: string[];
  stale_cell_ids: string[];
  inserted_cell_ids: string[];
  deleted_cell_ids: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseNotebookDocument(raw: string): NotebookDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid notebook JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value) || !Array.isArray(value.cells)) throw new Error("Invalid notebook: cells must be an array");
  const cells = value.cells.map((cell, index) => {
    if (!isRecord(cell)) throw new Error(`Invalid notebook cell at index ${index}`);
    return cell as NotebookCellDocument;
  });
  return { ...value, cells };
}

export function notebookSourceText(source: unknown): string {
  if (Array.isArray(source)) return source.map((line) => String(line)).join("");
  return typeof source === "string" ? source : "";
}

/**
 * Keep this hash in sync with frontend/src/components/notebook/notebook-model.ts.
 * It gives legacy cells a stable identity without rewriting a notebook merely
 * because an agent read it.
 */
function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function notebookCellId(path: string, cell: NotebookCellDocument, index: number): string {
  if (typeof cell.id === "string" && cell.id.trim()) return cell.id;
  return `cell-${stableHash(`${path}\0${index}\0${cell.cell_type ?? "unknown"}\0${notebookSourceText(cell.source)}`)}`;
}

export function normalizeNotebookDocument(document: NotebookDocument, path: string): NotebookDocument {
  return {
    ...document,
    cells: document.cells.map((cell, index) => ({
      ...cell,
      id: notebookCellId(path, cell, index),
    })),
  };
}

export function notebookSha256(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function serializeNotebookDocument(document: NotebookDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function applyNotebookEdits(document: NotebookDocument, operations: NotebookEditOperation[]): AppliedNotebookEdits {
  if (operations.length === 0) throw new Error("At least one notebook edit operation is required");
  const cells = document.cells.map((cell) => ({ ...cell }));
  const changed = new Set<string>();
  const stale = new Set<string>();
  const inserted = new Set<string>();
  const deleted = new Set<string>();

  for (const operation of operations) {
    if (operation.action === "insert_cell") {
      const cellId = operation.cell_id?.trim() || `cell-${randomUUID()}`;
      if (cells.some((cell) => cell.id === cellId)) throw new Error(`Notebook cell id already exists: ${cellId}`);
      const beforeIndex = operation.before_cell_id === undefined
        ? cells.length
        : cells.findIndex((cell) => cell.id === operation.before_cell_id);
      if (beforeIndex < 0) throw new Error(`Notebook cell not found: ${operation.before_cell_id}`);
      const cell: NotebookCellDocument = {
        id: cellId,
        cell_type: operation.cell_type,
        source: operation.source,
        ...(operation.cell_type === "code" ? { execution_count: null, outputs: [] } : {}),
      };
      cells.splice(beforeIndex, 0, cell);
      changed.add(cellId);
      inserted.add(cellId);
      continue;
    }
    const index = cells.findIndex((cell) => cell.id === operation.cell_id);
    if (index < 0) throw new Error(`Notebook cell not found: ${operation.cell_id}`);
    const cell = cells[index]!;
    if (operation.action === "replace_source") {
      const typeChanged = operation.cell_type !== undefined && cell.cell_type !== operation.cell_type;
      if (notebookSourceText(cell.source) !== operation.source || typeChanged) {
        cell.source = operation.source;
        if (operation.cell_type !== undefined) cell.cell_type = operation.cell_type;
        // A source edit invalidates displayed results. Execution is explicit
        // through notebook_run and must never silently reuse stale outputs.
        cell.outputs = [];
        cell.execution_count = null;
        stale.add(operation.cell_id);
      }
      changed.add(operation.cell_id);
    } else if (operation.action === "clear_outputs") {
      cell.outputs = [];
      cell.execution_count = null;
      changed.add(operation.cell_id);
      stale.add(operation.cell_id);
    } else {
      cells.splice(index, 1);
      deleted.add(operation.cell_id);
      changed.add(operation.cell_id);
    }
  }

  return {
    document: { ...document, cells },
    changed_cell_ids: [...changed],
    stale_cell_ids: [...stale],
    inserted_cell_ids: [...inserted],
    deleted_cell_ids: [...deleted],
  };
}
