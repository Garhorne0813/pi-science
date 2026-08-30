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
  it("presents a narrative label while precise tool titles stay in Trace", () => {
    render(<AgentActivity blocks={[tool("read", "read", "done", { path: "ConversationBlocks.tsx" }), tool("todo", "todo"), tool("search", "grep", "running", { pattern: "tool.updated" })]} />);
    expect(screen.getByText("Reviewing the implementation")).toBeInTheDocument();
    expect(screen.queryByText("Reading ConversationBlocks.tsx")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Reviewing the implementation/i }));
    expect(screen.getByLabelText("Execution trace")).toBeInTheDocument();
    expect(screen.getByText("Reading ConversationBlocks.tsx")).toBeInTheDocument();
  });

  it("shows completion as the main copy and operation count as metadata", () => {
    render(<AgentActivity lifecycle="settled" blocks={[tool("read", "read"), tool("todo", "todo"), tool("search", "grep")]} />);
    expect(screen.getByText("Complete")).toBeInTheDocument();
    expect(screen.getByLabelText("2 operations")).toHaveTextContent("2");
  });

  it("renders nothing for todo only", () => { const { container } = render(<AgentActivity blocks={[tool("todo", "todo")]} />); expect(container).toBeEmptyDOMElement(); });

  it("keeps opaque tools without semantics trace-only", () => {
    render(<AgentActivity blocks={[tool("bash", "bash", "running", { command: "git status" })]} />);
    expect(screen.queryByText(/Running commands|Working/)).not.toBeInTheDocument();
    expect(screen.getByText("Execution trace")).toBeInTheDocument();
  });

  it("holds implementation through test and corrective reads", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<AgentActivity blocks={[tool("read-1", "read", "running", { path: "first.ts" })]} />);
      expect(screen.getByText("Reviewing the implementation")).toBeInTheDocument();
      rerender(<AgentActivity blocks={[tool("read-1", "read"), tool("edit", "edit", "running", { path: "a.ts" })]} />);
      act(() => { vi.advanceTimersByTime(900); });
      expect(screen.getByText("Updating and verifying the implementation")).toBeInTheDocument();
      rerender(<AgentActivity blocks={[tool("read-1", "read"), tool("edit", "edit"), tool("test", "bash", "running", { description: "Run tests" }), tool("corrective", "read", "running", { path: "a.ts" })]} />);
      act(() => { vi.advanceTimersByTime(900); });
      expect(screen.getByText("Updating and verifying the implementation")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let partial output starve a narrative transition", () => {
    vi.useFakeTimers();
    try {
      const read = tool("read", "read", "running", { path: "a.ts" });
      const running = tool("test", "bash", "running", { description: "Run tests" });
      const { rerender } = render(<AgentActivity blocks={[read]} />);
      rerender(<AgentActivity blocks={[{ ...read, status: "done" }, running]} />);
      for (let elapsed = 100; elapsed <= 1_000; elapsed += 100) {
        act(() => { vi.advanceTimersByTime(100); });
        rerender(<AgentActivity blocks={[{ ...read, status: "done" }, { ...running, partialOutput: `line ${elapsed}` }]} />);
      }
      expect(screen.getByText("Verifying the changes")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders recovery and waiting states without a trace", () => {
    const { rerender } = render(<AgentActivity lifecycle="recovering" blocks={[]} />);
    expect(screen.getByText("Resuming the task")).toBeInTheDocument();
    rerender(<AgentActivity lifecycle="waiting" blocks={[]} />);
    expect(screen.getByText("Needs your input")).toBeInTheDocument();
  });
  it("shows recovery and interaction without execution trace items", () => {
    const { rerender, container } = render(<AgentActivity lifecycle="recovering" blocks={[tool("recovery", "runtime_recovery", "running")]} />);
    expect(screen.getByText("Resuming the task")).toBeInTheDocument();
    expect(container.querySelector(".lucide-chevron-right")).toBeNull();
    rerender(<AgentActivity lifecycle="waiting" blocks={[tool("ask", "ask_user_question", "waiting-approval")]} />);
    expect(screen.getByText("Needs your input")).toBeInTheDocument();
    expect(container.querySelector(".lucide-chevron-right")).toBeNull();
  });

  it("shows interaction, failure, and abort lifecycle copy", () => {
    const { rerender } = render(<AgentActivity lifecycle="waiting" blocks={[tool("read", "read"), tool("ask", "ask_user_question", "waiting-approval")]} />);
    expect(screen.getByText("Needs your input")).toBeInTheDocument();
    rerender(<AgentActivity lifecycle="failed" blocks={[tool("failed", "bash", "error", { description: "Run tests" })]} />);
    expect(screen.getByText("Encountered a problem")).toBeInTheDocument();
    rerender(<AgentActivity lifecycle="aborted" blocks={[tool("read", "read")]} />);
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });
});
