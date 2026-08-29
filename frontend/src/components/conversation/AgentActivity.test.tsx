import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "../../i18n";
import type { ToolCallBlock } from "../../types/thread";
import { AgentActivity } from "./AgentActivity";
import { executionActivities, executionOperationCount, selectCurrentActivity } from "../../lib/conversation/activity-policy";
const tool = (id: string, name: string, status: ToolCallBlock["status"] = "done", input?: Record<string, unknown>): ToolCallBlock => ({ kind: "tool", id, callId: `${id}-call`, tool: name, status, input, output: "output" });
beforeAll(async () => { await i18n.changeLanguage("en"); });
describe("AgentActivity selectors", () => {
  it("selects execution instead of todo", () => { expect(selectCurrentActivity([tool("todo-run", "todo", "running"), tool("read", "read", "running")])?.id).toBe("read"); });
  it("does not count todo", () => { expect(executionOperationCount([tool("a", "todo"), tool("b", "todo")])).toBe(0); });
  it("keeps todo out of trace", () => { expect(executionActivities([tool("read", "read"), tool("todo", "todo"), tool("search", "grep")]).map((block) => block.id)).toEqual(["read", "search"]); });
  it("does not keep an old error as the current activity after later work succeeds", () => { expect(selectCurrentActivity([tool("failed", "bash", "error"), tool("fixed", "bash", "done")])).toBeNull(); });
});
describe("AgentActivity", () => {
  it("renders one current line and an execution-only trace", () => {
    render(<AgentActivity blocks={[tool("read", "read", "done", { path: "ConversationBlocks.tsx" }), tool("todo", "todo"), tool("search", "grep", "running", { pattern: "tool.updated" })]} />);
    expect(screen.getByText("Searching for tool.updated")).toBeInTheDocument(); expect(screen.queryByText(/todo/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Searching for tool.updated/i }));
    expect(screen.getByLabelText("Execution trace")).toBeInTheDocument(); expect(screen.getByText("Reading ConversationBlocks.tsx")).toBeInTheDocument();
  });
  it("counts execution only", () => { render(<AgentActivity blocks={[tool("read", "read"), tool("todo", "todo"), tool("search", "grep")]} />); expect(screen.getByText("Completed · 2 operations")).toBeInTheDocument(); });
  it("renders nothing for todo only", () => { const { container } = render(<AgentActivity blocks={[tool("todo", "todo")]} />); expect(container).toBeEmptyDOMElement(); });
  it("folds raw details", () => {
    render(<AgentActivity blocks={[tool("read", "read", "done", { path: "event-fold.ts" })]} />);
    fireEvent.click(screen.getByRole("button", { name: /Completed · 1 operations/i })); fireEvent.click(screen.getByRole("button", { name: /Reading event-fold.ts/i }));
    expect(screen.getByText((_, element) => element?.tagName === "PRE" && element.textContent?.includes('"path": "event-fold.ts"') === true)).toBeInTheDocument();
  });
});
