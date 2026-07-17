import { describe, expect, it } from "vitest";
import {
  notebookKernel,
  kernelShutdownUrl,
  outputText,
  parseNotebookDocument,
  sourceText,
  stableNotebookId,
} from "./notebook-model";

describe("notebook model", () => {
  it("parses cells and detects Python and R kernels", () => {
    const python = parseNotebookDocument(JSON.stringify({
      cells: [{ cell_type: "code", source: ["x = 40\n", "x + 2"] }],
      metadata: { kernelspec: { language: "python", display_name: "Python 3" } },
    }));
    expect(notebookKernel(python)).toEqual({ language: "python", label: "Python 3" });
    expect(sourceText(python.cells[0].source)).toBe("x = 40\nx + 2");

    const r = parseNotebookDocument(JSON.stringify({
      cells: [],
      metadata: { kernelspec: { name: "ir", display_name: "R 4" } },
    }));
    expect(notebookKernel(r)).toEqual({ language: "r", label: "R 4" });
  });

  it("keeps unsupported notebooks viewable but non-runnable", () => {
    const notebook = parseNotebookDocument(JSON.stringify({
      cells: [],
      metadata: { language_info: { name: "julia" } },
    }));
    expect(notebookKernel(notebook)).toEqual({ language: "unsupported", label: "julia" });
  });

  it("rejects malformed notebooks and renders stored outputs", () => {
    expect(() => parseNotebookDocument("{}")).toThrow("cells array is missing");
    expect(outputText({ output_type: "stream", text: ["hello", "\n"] })).toBe("hello\n");
    expect(outputText({ output_type: "execute_result", data: { "text/plain": ["42"] } })).toBe("42");
    expect(outputText({ output_type: "error", ename: "ValueError", evalue: "bad" })).toBe("ValueError: bad");
  });

  it("builds stable path-safe kernel identifiers", () => {
    expect(stableNotebookId("analysis/demo.ipynb")).toBe(stableNotebookId("analysis/demo.ipynb"));
    expect(stableNotebookId("analysis/demo.ipynb")).not.toBe(stableNotebookId("other/demo.ipynb"));
    expect(stableNotebookId("analysis/demo.ipynb")).toMatch(/^file-[0-9a-f]+$/);
    expect(kernelShutdownUrl("notebook/a", "/tmp/project one")).toBe(
      "/api/kernels/notebook%2Fa/shutdown?cwd=%2Ftmp%2Fproject+one",
    );
  });
});
