import { describe, expect, it } from "vitest";
import {
  applyNotebookEdits,
  applyNotebookExecutionOutput,
  normalizeNotebookDocument,
  notebookCellId,
  parseNotebookDocument,
  serializeNotebookDocument,
} from "./notebook-document.js";

describe("notebook document operations", () => {
  it("assigns legacy cell ids that match the frontend identity algorithm", () => {
    const document = normalizeNotebookDocument(parseNotebookDocument(JSON.stringify({ cells: [{ cell_type: "code", source: "x = 1\n" }] })), "analysis/demo.ipynb");
    expect(document.cells[0]?.id).toBe("cell-188f6a19");
    expect(notebookCellId("analysis/demo.ipynb", document.cells[0]!, 0)).toBe(document.cells[0]?.id);
  });

  it("keeps legacy ids when source text changes before the notebook is saved", () => {
    const first = normalizeNotebookDocument(parseNotebookDocument(JSON.stringify({ cells: [{ cell_type: "code", source: "x = 1\n" }] })), "analysis/demo.ipynb");
    const changed = normalizeNotebookDocument(parseNotebookDocument(JSON.stringify({ cells: [{ cell_type: "code", source: "x = 2\n" }] })), "analysis/demo.ipynb");
    expect(changed.cells[0]?.id).toBe(first.cells[0]?.id);
  });

  it("clears stale execution state when source changes", () => {
    const document = normalizeNotebookDocument(parseNotebookDocument(JSON.stringify({
      cells: [{ cell_type: "code", source: "x = 1\n", execution_count: 1, outputs: [{ output_type: "execute_result" }] }],
    })), "demo.ipynb");
    const cellId = document.cells[0]!.id!;
    const applied = applyNotebookEdits(document, [{ cell_id: cellId, action: "replace_source", source: "x = 2\n" }]);

    expect(applied.changed_cell_ids).toEqual([cellId]);
    expect(applied.stale_cell_ids).toEqual([cellId]);
    expect(applied.document.cells[0]).toMatchObject({ source: "x = 2\n", execution_count: null, outputs: [] });
  });

  it("keeps explicit ids and serializes valid notebook JSON", () => {
    const document = normalizeNotebookDocument(parseNotebookDocument(JSON.stringify({ cells: [{ id: "kept", cell_type: "markdown", source: "# hi" }] })), "demo.ipynb");
    expect(document.cells[0]?.id).toBe("kept");
    expect(JSON.parse(serializeNotebookDocument(document))).toMatchObject({ cells: [{ id: "kept" }] });
  });

  it("supports ordered insertion and deletion by stable cell id", () => {
    const document = normalizeNotebookDocument(parseNotebookDocument(JSON.stringify({
      cells: [
        { id: "first", cell_type: "markdown", source: "# first" },
        { id: "last", cell_type: "code", source: "1 + 1" },
      ],
    })), "demo.ipynb");
    const inserted = applyNotebookEdits(document, [{ action: "insert_cell", cell_id: "middle", before_cell_id: "last", cell_type: "code", source: "x = 1\n" }]);
    expect(inserted.document.cells.map((cell) => cell.id)).toEqual(["first", "middle", "last"]);
    expect(inserted.inserted_cell_ids).toEqual(["middle"]);

    const deleted = applyNotebookEdits(inserted.document, [{ action: "delete_cell", cell_id: "middle" }]);
    expect(deleted.document.cells.map((cell) => cell.id)).toEqual(["first", "last"]);
    expect(deleted.deleted_cell_ids).toEqual(["middle"]);
  });

  it("updates execution output without changing the cell identity", () => {
    const document = normalizeNotebookDocument(parseNotebookDocument(JSON.stringify({
      cells: [{ id: "run-me", cell_type: "code", source: "1 + 1", execution_count: null, outputs: [] }],
    })), "demo.ipynb");
    const updated = applyNotebookExecutionOutput(document, {
      cell_id: "run-me",
      execution_count: 1,
      outputs: [{ output_type: "execute_result", execution_count: 1, data: { "text/plain": "2" } }],
    });

    expect(updated.cells[0]).toMatchObject({ id: "run-me", execution_count: 1, outputs: [{ output_type: "execute_result" }] });
  });
});
