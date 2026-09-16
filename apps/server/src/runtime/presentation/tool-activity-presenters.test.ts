import { describe, expect, it } from "vitest";
import { toolActivityPresentation, toolActivityTitle } from "./tool-activity-presenters.js";

describe("toolActivityTitle", () => {
  it("hides plan and interaction tools", () => { expect(toolActivityTitle("todo", {})).toBeUndefined(); expect(toolActivityTitle("ask_user_question", {})).toBeUndefined(); });
  it("creates deterministic titles", () => { expect(toolActivityTitle("read", { path: "src/file.ts" })).toBe("Reading file.ts"); expect(toolActivityTitle("grep", { pattern: "tool.updated" })).toBe("Searching for tool.updated"); });
  it("uses descriptions but not raw shell commands", () => { expect(toolActivityTitle("bash", { command: "pnpm test", description: "Running tests" })).toBe("Running tests"); expect(toolActivityTitle("bash", { command: "rm -rf x" })).toBeUndefined(); });
  it("returns replayable semantics for built-in and opaque tools", () => {
    expect(toolActivityPresentation("notebook_run", {})).toMatchObject({ version: 1, kind: "compute", domain: "science", importance: "stage" });
    expect(toolActivityPresentation("bash", { description: "Run frontend tests" })).toMatchObject({ kind: "verify", domain: "code", description: "Run frontend tests" });
    expect(toolActivityPresentation("image_gen", {})).toMatchObject({ kind: "artifact", domain: "document", narrativeHint: { state: "generate" } });
    expect(toolActivityPresentation("bash", { command: "git status" })).toBeUndefined();
  });
});
