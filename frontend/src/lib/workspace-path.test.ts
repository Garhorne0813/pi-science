import { describe, expect, it } from "vitest";
import { workspacePathLeaf } from "./workspace-path";

describe("workspacePathLeaf", () => {
  it("extracts POSIX and Windows workspace names", () => {
    expect(workspacePathLeaf("/Users/scientist/Climate Study")).toBe("Climate Study");
    expect(workspacePathLeaf("C:\\Users\\scientist\\Climate Study")).toBe("Climate Study");
  });

  it("ignores trailing path separators", () => {
    expect(workspacePathLeaf("/tmp/workspace/")).toBe("workspace");
    expect(workspacePathLeaf("C:\\workspaces\\workspace\\")).toBe("workspace");
  });

  it("preserves a separator-free workspace name and leaves roots unnamed", () => {
    expect(workspacePathLeaf("workspace")).toBe("workspace");
    expect(workspacePathLeaf("/")).toBe("");
    expect(workspacePathLeaf("C:\\")).toBe("");
  });
});
