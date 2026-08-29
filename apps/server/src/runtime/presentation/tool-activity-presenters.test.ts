import { describe, expect, it } from "vitest";
import { toolActivityTitle } from "./tool-activity-presenters.js";
describe("toolActivityTitle", () => {
  it("hides plan and interaction tools", () => { expect(toolActivityTitle("todo", {})).toBeUndefined(); expect(toolActivityTitle("ask_user_question", {})).toBeUndefined(); });
  it("creates deterministic titles", () => { expect(toolActivityTitle("read", { path: "src/file.ts" })).toBe("Reading file.ts"); expect(toolActivityTitle("grep", { pattern: "tool.updated" })).toBe("Searching for tool.updated"); });
  it("uses descriptions but not raw shell commands", () => { expect(toolActivityTitle("bash", { command: "pnpm test", description: "Running tests" })).toBe("Running tests"); expect(toolActivityTitle("bash", { command: "rm -rf x" })).toBeUndefined(); });
});
