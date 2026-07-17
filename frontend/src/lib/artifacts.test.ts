import { describe, expect, it } from "vitest";
import { fileInspectorForPath, previewKind } from "./artifacts";

describe("artifact inspector routing", () => {
  it("opens notebooks in the executable notebook inspector", () => {
    expect(fileInspectorForPath("research/demo.ipynb", "demo.ipynb")).toEqual({
      variant: "notebook-file",
      path: "research/demo.ipynb",
      root: undefined,
      cwd: undefined,
    });
  });

  it("routes supported Office files to their native previews", () => {
    expect(previewKind("docx")).toBe("docx");
    expect(previewKind("xlsx")).toBe("xlsx");
    expect(previewKind("pptx")).toBe("pptx");
  });
});
