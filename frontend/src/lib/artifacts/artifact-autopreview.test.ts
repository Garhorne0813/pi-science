import { describe, expect, it } from "vitest";
import { pickAutoPreviewArtifact } from "./artifact-autopreview";

describe("pickAutoPreviewArtifact", () => {
  it("picks the last previewable ref when several qualify", () => {
    expect(pickAutoPreviewArtifact(["out/fig1.png", "out/report.html"], { inspectorOpen: false }))
      .toBe("out/report.html");
  });

  it("skips trailing refs whose extension is not previewable", () => {
    expect(pickAutoPreviewArtifact(["out/plot.png", "src/main.py", "data/table.json"], { inspectorOpen: false }))
      .toBe("out/plot.png");
  });

  it("accepts every auto-preview extension, case-insensitively", () => {
    for (const ext of ["png", "jpg", "jpeg", "svg", "gif", "webp", "html", "htm", "md", "csv", "pdf"]) {
      expect(pickAutoPreviewArtifact([`out/artifact.${ext}`], { inspectorOpen: false })).toBe(`out/artifact.${ext}`);
    }
    expect(pickAutoPreviewArtifact(["out/REPORT.PDF"], { inspectorOpen: false })).toBe("out/REPORT.PDF");
  });

  it("returns null when no ref is previewable", () => {
    expect(pickAutoPreviewArtifact(["src/main.py", "runs/model.pdb", "data/x.json"], { inspectorOpen: false })).toBeNull();
    expect(pickAutoPreviewArtifact([], { inspectorOpen: false })).toBeNull();
  });

  it("never replaces an inspector the user already has open", () => {
    expect(pickAutoPreviewArtifact(["out/plot.png"], { inspectorOpen: true })).toBeNull();
  });
});
