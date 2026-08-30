import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import i18n from "../../i18n";
import type { ToolCallBlock } from "../../types/thread";
import { AgentActivity } from "./AgentActivity";
import { executionActivities, executionOperationCount } from "../../lib/conversation/activity-policy";
const tool = (id: string, name: string, status: ToolCallBlock["status"] = "done", input?: Record<string, unknown>): ToolCallBlock => ({ kind: "tool", id, callId: `${id}-call`, tool: name, status, input, output: "output" });
beforeAll(async () => { await i18n.changeLanguage("en"); });
describe("AgentActivity data filters", () => {
  it("does not count todo", () => { expect(executionOperationCount([tool("a", "todo"), tool("b", "todo")])).toBe(0); });
  it("keeps todo out of trace", () => { expect(executionActivities([tool("read", "read"), tool("todo", "todo"), tool("search", "grep")]).map((block) => block.id)).toEqual(["read", "search"]); });
});
describe("AgentActivity", () => {
  it("presents a phase label, not the last tool", () => {
    render(<AgentActivity blocks={[tool("read", "read", "done", { path: "ConversationBlocks.tsx" }), tool("todo", "todo"), tool("search", "grep", "running", { pattern: "tool.updated" })]} />);
    expect(screen.getByText("Inspecting the code")).toBeInTheDocument();
    expect(screen.queryByText("Reading ConversationBlocks.tsx")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Inspecting the code/i }));
    expect(screen.getByLabelText("Execution trace")).toBeInTheDocument();
    expect(screen.getByText("Reading ConversationBlocks.tsx")).toBeInTheDocument();
  });
  it("counts execution only", () => { render(<AgentActivity completed blocks={[tool("read", "read"), tool("todo", "todo"), tool("search", "grep")]} />); expect(screen.getByText("Completed · 2 operations")).toBeInTheDocument(); });
  it("renders nothing for todo only", () => { const { container } = render(<AgentActivity blocks={[tool("todo", "todo")]} />); expect(container).toBeEmptyDOMElement(); });
  it("folds raw details", () => {
    render(<AgentActivity completed blocks={[tool("read", "read", "done", { path: "event-fold.ts" })]} />);
    fireEvent.click(screen.getByRole("button", { name: /Completed · 1 operations/i })); fireEvent.click(screen.getByRole("button", { name: /Reading event-fold.ts/i }));
    expect(screen.getByText((_, element) => element?.tagName === "PRE" && element.textContent?.includes('"path": "event-fold.ts"') === true)).toBeInTheDocument();
  });
  it("holds one phase label through a micro burst and switches only on a real phase change", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<AgentActivity blocks={[tool("read-1", "read", "running", { path: "first.ts" })]} />);
      expect(screen.getByText("Inspecting the code")).toBeInTheDocument();
      rerender(<AgentActivity blocks={[tool("read-1", "read", "done"), tool("grep", "grep", "done"), tool("read-2", "read", "running")]} />);
      expect(screen.getByText("Inspecting the code")).toBeInTheDocument();
      rerender(<AgentActivity blocks={[tool("read-1", "read", "done"), tool("grep", "grep", "done"), tool("edit", "edit", "running", { path: "ConversationBlocks.tsx" })]} />);
      expect(screen.getByText("Inspecting the code")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(900); });
      expect(screen.getByText("Updating the code")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
  it("shows waiting interactions immediately", () => {
    render(<AgentActivity blocks={[tool("read", "read"), tool("ask", "ask_user_question", "waiting-approval")]} />);
    expect(screen.getByText("Waiting for your approval")).toBeInTheDocument();
  });
  it("summarizes failures after the final answer starts", () => {
    render(<AgentActivity completed blocks={[tool("failed", "bash", "error"), tool("fixed", "bash", "done")]} />);
    expect(screen.getByText("Completed · 2 operations, 1 failed")).toBeInTheDocument();
  });
});
