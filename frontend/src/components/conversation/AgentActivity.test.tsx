import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import i18n from "../../i18n";
import type { ToolCallBlock } from "../../types/thread";
import { AgentActivity } from "./AgentActivity";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { executionActivities, executionOperationCount } from "../../lib/conversation/activity-policy";
import { defaultProgressAppearance } from "@pi-science/contracts";
import { setProgressAppearance } from "../progress/progress-settings-store";

const tool = (id: string, name: string, status: ToolCallBlock["status"] = "done", input?: Record<string, unknown>): ToolCallBlock => ({ kind: "tool", id, callId: `${id}-call`, tool: name, status, input, output: "output" });
beforeAll(async () => { await i18n.changeLanguage("en"); });
beforeEach(() => { setProgressAppearance(defaultProgressAppearance); });

describe("AgentActivity data filters", () => {
  it("does not count todo", () => { expect(executionOperationCount([tool("a", "todo"), tool("b", "todo")])).toBe(0); });
  it("keeps todo out of trace", () => { expect(executionActivities([tool("read", "read"), tool("todo", "todo"), tool("search", "grep")]).map((block) => block.id)).toEqual(["read", "search"]); });
});

describe("AgentActivity", () => {
  it("updates the task immediately when consecutive tools share the same phase", () => {
    const read = tool("read", "read", "running", { path: "a.ts", description: "Find why the second reply stops following" });
    const { rerender } = render(<AgentActivity blocks={[read]} />);
    expect(screen.getByText("Find why the second reply stops following")).toBeInTheDocument();
    rerender(<AgentActivity blocks={[{ ...read, status: "done" }, tool("next", "read", "running", { path: "b.ts", description: "Check how virtual list measurements update" })]} />);
    expect(screen.getByText("Reviewing the implementation")).toBeInTheDocument();
    expect(screen.getByText("Check how virtual list measurements update")).toBeInTheDocument();
    expect(screen.queryByText("Find why the second reply stops following")).not.toBeInTheDocument();
  });

  it("names a running tool that carries no task description", () => {
    render(<AgentActivity blocks={[tool("bash-1", "bash", "running")]} />);
    // The status detail and the tool's own line both name the running tool.
    expect(screen.getAllByText("Running bash")).toHaveLength(2);
    expect(screen.queryByText("Understanding your request and deciding what to do next")).not.toBeInTheDocument();
  });

  it("keeps the curated task text ahead of the mechanical tool label", () => {
    render(<AgentActivity blocks={[tool("bash-1", "bash", "running", { description: "Install the pinned toolchain" })]} />);
    expect(screen.getAllByText("Install the pinned toolchain")).toHaveLength(2);
    expect(screen.queryByText("Running bash")).not.toBeInTheDocument();
  });

  it("shows a live turn elapsed timer that stops when the turn settles", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const { container, rerender } = render(<AgentActivity blocks={[tool("read-1", "read", "running", { path: "a.ts" })]} />);
      act(() => { vi.advanceTimersByTime(2_400); });
      expect(container.querySelector('[aria-hidden="true"].font-mono')?.textContent).toMatch(/^\d+\.\ds$/);
      rerender(<AgentActivity blocks={[tool("read-1", "read", "done", { path: "a.ts" })]} lifecycle="settled" />);
      expect(container.querySelector('[aria-hidden="true"].font-mono')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a visible trail of the last steps after settling", () => {
    const blocks = [
      tool("t1", "read", "done", { path: "one.ts" }),
      tool("t2", "read", "done", { path: "two.ts" }),
      tool("t3", "grep", "done", { pattern: "x" }),
      tool("t4", "bash", "done"),
      tool("t5", "bash", "done"),
    ];
    render(<AgentActivity blocks={blocks} lifecycle="settled" />);
    expect(screen.queryByText("Reading one.ts")).not.toBeInTheDocument();
    expect(screen.getByText("Reading two.ts")).toBeInTheDocument();
    expect(screen.getByText("Searching for x")).toBeInTheDocument();
    expect(screen.getAllByText("Running bash")).toHaveLength(2);
  });

  it("shows a per-step duration when the block carries timestamps", () => {
    render(<AgentActivity blocks={[{ ...tool("t1", "bash", "done"), startedAt: "2026-09-08T00:00:00.000Z", endedAt: "2026-09-08T00:00:02.400Z" }]} lifecycle="settled" />);
    expect(screen.getByText("2.4s")).toBeInTheDocument();
  });

  it("offers an interrupt affordance while the turn runs", async () => {
    const abort = vi.fn().mockResolvedValue(undefined);
    const previous = useRuntimeStore.getState().abort;
    useRuntimeStore.setState({ abort: abort as typeof previous });
    try {
      render(<AgentActivity blocks={[tool("bash-1", "bash", "running")]} />);
      await fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      expect(abort).toHaveBeenCalledTimes(1);
    } finally {
      useRuntimeStore.setState({ abort: previous });
    }
  });

  it("streams the live trace open with the status row pinned after it", () => {
    const { container } = render(<AgentActivity blocks={[tool("read", "read", "done", { path: "ConversationBlocks.tsx" }), tool("todo", "todo"), tool("search", "grep", "running", { pattern: "tool.updated" })]} />);
    // Status row: narrative title and task detail share one line, no toggle.
    const title = screen.getByText("Reviewing the implementation");
    const statusRow = title.closest("div[data-state]")!;
    const detail = within(statusRow as HTMLElement).getByText("Locating evidence for the current task");
    expect(title.parentElement).toBe(detail.parentElement);
    expect(container.firstElementChild).not.toHaveClass("border");
    expect(document.querySelector('[data-orb-variant="S4"]')).toBeInTheDocument();
    // The stream is open by default: every tool is its own line, no fold.
    const trace = screen.getByLabelText("Execution trace");
    expect(within(trace).getByText("Reading ConversationBlocks.tsx")).toBeInTheDocument();
    expect(within(trace).getByText("Searching for tool.updated")).toBeInTheDocument();
    expect(within(trace).queryByRole("button", { name: /Execution details/i })).not.toBeInTheDocument();
  });

  it("presents settled steps as the row itself without a header or count", () => {
    render(<AgentActivity lifecycle="settled" blocks={[tool("read", "read"), tool("todo", "todo"), tool("search", "grep")]} />);
    // The settled-state announcement survives as sr-only copy; no visible header.
    expect(screen.queryByText("Complete", { ignore: ".sr-only" })).not.toBeInTheDocument();
    expect(screen.getByText("Reading file")).toBeInTheDocument();
    expect(screen.getByText("Searching for matching code")).toBeInTheDocument();
    expect(screen.queryByLabelText(/operation/)).not.toBeInTheDocument();
  });

  it("keeps the active status visible for todo-only turns", () => { render(<AgentActivity blocks={[tool("todo", "todo")]} />); expect(screen.getByText("Thinking")).toBeInTheDocument(); expect(screen.queryByLabelText("Execution trace")).not.toBeInTheDocument(); });

  it.each(["settled", "aborted", "failed"] as const)("collapses on %s, allows review, and reopens for the next run", (lifecycle) => {
    const blocks = [tool("read", "read", "running", { path: "a.ts" })];
    const { rerender, container } = render(<AgentActivity blocks={blocks} />);
    // The live stream stays open through waiting and recovery.
    expect(screen.getByLabelText("Execution trace")).toBeInTheDocument();
    rerender(<AgentActivity blocks={[...blocks, tool("search", "grep", "running")]} lifecycle="waiting" />);
    expect(screen.getByLabelText("Execution trace")).toBeInTheDocument();
    rerender(<AgentActivity blocks={blocks} lifecycle="recovering" />);
    expect(screen.getByText("Resuming the task")).toBeInTheDocument();

    rerender(<AgentActivity blocks={blocks} lifecycle={lifecycle} />);
    expect(screen.queryByLabelText("Execution trace")).not.toBeInTheDocument();
    const summary = screen.getByRole("button", { expanded: false });
    // Settled turns present their steps as the row; aborted and failed ones
    // keep the state headline.
    if (lifecycle === "settled") expect(summary).toHaveTextContent("Reading a.ts");
    else expect(summary).toHaveTextContent(lifecycle === "aborted" ? "Stopped" : "Encountered a problem");
    fireEvent.click(summary);
    expect(screen.getByLabelText("Execution trace")).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).toBeNull();
    fireEvent.click(summary);

    rerender(<AgentActivity blocks={blocks} lifecycle="active" />);
    expect(screen.getByLabelText("Execution trace")).toBeInTheDocument();
  });

  it("uses the generation narrative and orb for image generation", () => {
    render(<AgentActivity blocks={[tool("image", "image_gen", "running")]} />);
    expect(screen.getByText("Generating the output")).toBeInTheDocument();
    expect(document.querySelector('[data-orb-variant="B3"]')).toBeInTheDocument();
  });

  it("uses the thinking pattern when a tool has no semantics", () => {
    render(<AgentActivity blocks={[tool("bash", "bash", "running", { command: "git status" })]} />);
    // The row keeps the thinking visual, and the detail names the running
    // tool instead of a generic orient sentence.
    expect(screen.getAllByText("Running bash")).toHaveLength(2);
    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });

  it("holds implementation through test and corrective reads", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<AgentActivity blocks={[tool("read-1", "read", "running", { path: "first.ts" })]} />);
      expect(screen.getByText("Reviewing the implementation")).toBeInTheDocument();
      rerender(<AgentActivity blocks={[tool("read-1", "read"), tool("edit", "edit", "running", { path: "a.ts" })]} />);
      act(() => { vi.advanceTimersByTime(900); });
      expect(screen.getByText("Updating and verifying the implementation")).toBeInTheDocument();
      expect(document.querySelector('[data-orb-variant="B4"]')).toBeInTheDocument();
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
      expect(document.querySelector('[data-orb-variant="C5"]')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders recovery and waiting states without a trace", () => {
    const { rerender } = render(<AgentActivity lifecycle="recovering" blocks={[]} />);
    expect(screen.getByText("Resuming the task")).toBeInTheDocument();
    expect(document.querySelector('[data-orb-variant]')).toHaveAttribute("data-orb-variant", "G4");
    rerender(<AgentActivity lifecycle="waiting" blocks={[]} />);
    expect(screen.getByText("Needs your input")).toBeInTheDocument();
    expect(document.querySelector('[data-orb-variant="C2"]')).toBeInTheDocument();
  });
  it("shows recovery and interaction without execution trace items", () => {
    const { rerender, container } = render(<AgentActivity lifecycle="recovering" blocks={[tool("recovery", "runtime_recovery", "running")]} />);
    expect(screen.getByText("Resuming the task")).toBeInTheDocument();
    expect(container.querySelector(".lucide-chevron-right")).toBeNull();
    rerender(<AgentActivity lifecycle="waiting" blocks={[tool("ask", "ask_user_question", "waiting-approval")]} />);
    expect(screen.getByText("Needs your input")).toBeInTheDocument();
    expect(container.querySelector(".lucide-chevron-right")).toBeNull();
  });

  it("keeps progress copy neutral for a recoverable tool error", () => {
    render(<AgentActivity blocks={[tool("edit", "edit"), tool("failed", "bash", "error", { description: "Run tests" }), tool("next", "edit", "running")]} />);
    expect(screen.getByText("Updating and verifying the implementation")).toBeInTheDocument();
    expect(screen.queryByText("Encountered a problem")).not.toBeInTheDocument();
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
