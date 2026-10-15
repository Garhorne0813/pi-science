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

  it("extracts names from persisted Windows-style references", () => {
    expect(referencesFromMessage('<workspace_references>\n- file: "reports\\\\final.pdf"\n</workspace_references>')).toEqual([
      { path: "reports\\final.pdf", name: "final.pdf", isDir: false },
    ]);
  });

  it("shows the research objective instead of the expanded skill protocol, preserving file references", () => {
    const objective = injectWorkspaceReferences("Investigate latency", references);
    const expanded = `<skill name="auto-research" location="/project/.pi/skills/auto-research/SKILL.md">\nReferences are relative to /project/.pi/skills/auto-research.\n\n# Internal evaluation protocol\nDelegate bounded subquestions.\n</skill>\n\n[Workflow: optimize]\n${objective}`;
    expect(visibleUserMessage(expanded)).toBe("Investigate latency");
    expect(referencesFromMessage(expanded)).toEqual(references.map(({ cwd: _cwd, ...reference }) => reference));
    expect(visibleUserMessage(`/skill:auto-research [Workflow: optimize]\n${objective}`)).toBe("Investigate latency");
  });

  it("keeps skill-only invocation recognizable and ordinary XML text visible", () => {
    const expanded = '<skill name="inspect" location="/project/.pi/skills/inspect/SKILL.md">\nReferences are relative to /project/.pi/skills/inspect.\n\nRead evidence.\n</skill>';
    expect(visibleUserMessage(expanded)).toBe("/skill:inspect");
    expect(visibleUserMessage("Discuss <skill>scientific reasoning</skill>")).toBe("Discuss <skill>scientific reasoning</skill>");
  });

  it("leaves ordinary user messages untouched", () => {
    expect(injectWorkspaceReferences("Hello", [])).toBe("Hello");
    expect(visibleUserMessage("Hello")).toBe("Hello");
    expect(referencesFromMessage("Hello")).toEqual([]);
  });
});
