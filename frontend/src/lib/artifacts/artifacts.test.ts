import { describe, expect, it } from "vitest";
import { extractArtifactRefs, fileInspectorForPath, previewKind, publishedArtifactRefs } from "./artifacts";
import type { ThreadBlock } from "../../types/thread";

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

  it("does not turn a generic Markdown filename in prose into a workspace artifact", () => {
    expect(extractArtifactRefs("Each skill has a `SKILL.md` file with detailed instructions.")).toEqual([]);
    expect(extractArtifactRefs("See `.pi/skills/tdd/SKILL.md` for the workflow.")).toEqual([
      ".pi/skills/tdd/SKILL.md",
    ]);
  });

  it("does not turn a bare source filename from example prose into an artifact", () => {
    expect(extractArtifactRefs('For example, ask me to edit "main.py".')).toEqual([]);
    expect(extractArtifactRefs("I updated `src/main.py`.")).toEqual(["src/main.py"]);
  });

  it("normalizes before deduping equivalent prose references", () => {
    expect(extractArtifactRefs("See `./work/plot.png` and `work/plot.png`.")).toEqual(["work/plot.png"]);
  });

  it("ignores file-like references inside hidden HTML comments", () => {
    expect(extractArtifactRefs("Visible answer. <!--suggest: open results/report.pdf -->")).toEqual([]);
  });

  it("only keeps prose references that have a successful publication event", () => {
    const blocks: ThreadBlock[] = [{
      kind: "status-line",
      id: "artifact-report",
      text: "Published artifact: outputs/report.md",
      level: "done",
      path: "outputs/report.md",
    }];

    expect(publishedArtifactRefs(
      ["drafts/plan.md", "outputs/report.md"],
      blocks,
    )).toEqual(["outputs/report.md"]);
  });
});
