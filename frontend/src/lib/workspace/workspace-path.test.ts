import { describe, expect, it } from "vitest";
import { pathLeaf, workspacePathLeaf } from "../workspace";

describe("workspacePathLeaf", () => {
  it("extracts POSIX and Windows workspace names", () => {
    expect(workspacePathLeaf("/Users/scientist/Climate Study")).toBe("Climate Study");
    expect(workspacePathLeaf("C:\\Users\\scientist\\Climate Study")).toBe("Climate Study");
  });

  it("ignores trailing path separators", () => {
    expect(workspacePathLeaf("/tmp/workspace/")).toBe("workspace");
    expect(workspacePathLeaf("C:\\workspaces\\workspace\\")).toBe("workspace");
  });

  it("preserves a separator-free workspace name and leaves local and UNC roots unnamed", () => {
    expect(workspacePathLeaf("workspace")).toBe("workspace");
    expect(workspacePathLeaf("/")).toBe("");
    expect(workspacePathLeaf("C:\\")).toBe("");
    expect(workspacePathLeaf("\\\\server\\share\\")).toBe("");
    expect(workspacePathLeaf("//server/share/")).toBe("");
    expect(workspacePathLeaf("\\\\server\\share\\project")).toBe("project");
  });

  it("extracts file leaves from either persisted separator style", () => {
    expect(pathLeaf("reports/final.pdf")).toBe("final.pdf");
    expect(pathLeaf("reports\\final.pdf")).toBe("final.pdf");
  });
});
