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
    expect(message).not.toContain("inspect the lower crop first");
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

it("directs the agent to the crop and retains the region reference across transcript reload", () => {
  const reference = { cwd: "/study", path: "image-regions/fbaf434f-c2d8-4343-885a-e36ee1591629.png",
    isDir: false, name: "plot.png", imageRegion: "results/plot.png [x=10, y=15, w=20, h=35 px]" };
  const message = injectWorkspaceReferences("Why is this peak split?", [reference]);
  expect(message).toContain("inspect the lower crop first and use it as the primary visual evidence");
  expect(message).toContain("supply context only when needed for that answer");
  expect(message).toContain("Explain the full image only if the user explicitly asks for it");
  expect(message).toContain("state what cannot be determined from the selection");
  expect(visibleUserMessage(message)).toBe("Why is this peak split?");
  expect(referencesFromMessage(message)).toEqual([expect.objectContaining({ path: reference.path, imageRegion: reference.imageRegion })]);
});

it("reopens region references from messages sent before the crop guidance was added", () => {
  const path = "image-regions/fbaf434f-c2d8-4343-885a-e36ee1591629.png";
  const imageRegion = "results/plot.png [x=10, y=15, w=20, h=35 px]";
  const message = `What is here?\n\n<workspace_references>\n- image-region (read this PNG for the marked overview above and detail below): ${JSON.stringify([path, imageRegion])}\n</workspace_references>`;
  expect(visibleUserMessage(message)).toBe("What is here?");
  expect(referencesFromMessage(message)).toEqual([expect.objectContaining({ path, imageRegion })]);
});
