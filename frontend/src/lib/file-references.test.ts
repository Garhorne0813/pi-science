import { describe, expect, it } from "vitest";

import { injectWorkspaceReferences, referencesFromMessage, visibleUserMessage } from "./file-references";

describe("workspace reference messages", () => {
  const references = [
    { cwd: "/project", path: "data/results.csv", name: "results.csv", isDir: false },
    { cwd: "/project", path: "notes/review set", name: "review set", isDir: true },
  ];

  it("injects model-visible file and folder context without changing visible user text", () => {
    const message = injectWorkspaceReferences("Compare these results", references);

    expect(message).toContain("<workspace_references>");
    expect(message).toContain('- file: "data/results.csv"');
    expect(message).toContain('- folder: "notes/review set"');
    expect(visibleUserMessage(message)).toBe("Compare these results");
    expect(referencesFromMessage(message)).toEqual([
      { path: "data/results.csv", name: "results.csv", isDir: false },
      { path: "notes/review set", name: "review set", isDir: true },
    ]);
  });

  it("leaves ordinary user messages untouched", () => {
    expect(injectWorkspaceReferences("Hello", [])).toBe("Hello");
    expect(visibleUserMessage("Hello")).toBe("Hello");
    expect(referencesFromMessage("Hello")).toEqual([]);
  });
});
