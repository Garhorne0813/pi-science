import { describe, expect, it } from "vitest";
import type { ToolCallBlock } from "../../types/thread";
import { presentToolActivity } from "./activity-presenters";
const block = (tool: string, input?: Record<string, unknown>, title?: string): ToolCallBlock => ({ kind: "tool", id: tool, callId: tool, tool, status: "running", input, title });
describe("presentToolActivity", () => {
  it("prefers the server title", () => { expect(presentToolActivity(block("bash", {}, "Running tests"))).toBe("Running tests"); });
  it("presents file and search actions", () => { expect(presentToolActivity(block("read", { path: "src/file.ts" }))).toBe("Reading file.ts"); expect(presentToolActivity(block("grep", { pattern: "tool.updated" }))).toBe("Searching for tool.updated"); });
  it("prefers command descriptions and falls back to recognized shell actions", () => {
    expect(presentToolActivity(block("bash", { command: "pnpm test", description: "Running tests" }))).toBe("Running tests");
    expect(presentToolActivity(block("bash", { command: "pnpm test" }, "Running bash"))).toBe("Running pnpm test");
    expect(presentToolActivity(block("bash", { command: "rm -rf x" }))).toBe("Running bash");
  });

  it("keeps shell arguments, assignments and chained commands out of summaries", () => {
    expect(presentToolActivity(block("bash", { command: "git status --token=secret && echo secret" }))).toBe("Running git status …");
    expect(presentToolActivity(block("bash", { command: "TOKEN=secret pnpm test" }))).toBe("Running bash");
    expect(presentToolActivity(block("bash", { command: "python -c 'print(secret)'" }))).toBe("Running python …");
  });

  it("uses a generic tool's display description when its title is a placeholder", () => {
    const tool = block("mcp_lookup", { token: "secret" }, "Running mcp lookup");
    tool.presentation = { version: 1, kind: "search", title: "mcp_lookup", description: "Look up study metadata", importance: "micro", domain: "research" };
    expect(presentToolActivity(tool)).toBe("Look up study metadata");
  });
});
