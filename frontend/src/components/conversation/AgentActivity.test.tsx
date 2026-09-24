import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import i18n from "../../i18n";
import type { ActivityBlock } from "./AgentActivity";
import type { ToolCallBlock } from "../../types/thread";
import { AgentActivity } from "./AgentActivity";
import { executionActivities, executionOperationCount } from "../../lib/conversation/activity-policy";
import { defaultProgressAppearance } from "@pi-science/contracts";
import { setProgressAppearance } from "../progress/progress-settings-store";
import { activityRendererRegistry } from "./activity-renderers/registry";

const tool = (id: string, name: string, status: ToolCallBlock["status"] = "done", input?: Record<string, unknown>): ToolCallBlock => ({ kind: "tool", id, callId: `${id}-call`, tool: name, status, input, output: "output" });
beforeAll(async () => { await i18n.changeLanguage("en"); });
beforeEach(() => { setProgressAppearance(defaultProgressAppearance); });

describe("AgentActivity data filters", () => {
  it("does not count todo", () => { expect(executionOperationCount([tool("a", "todo"), tool("b", "todo")])).toBe(0); });
  it("counts a retried call once while preserving its status history", () => {
    const first = tool("a", "bash", "error");
    const retry = { ...first, status: "done" as const, statusHistory: ["error" as const, "done" as const] };
    expect(executionOperationCount([first, retry])).toBe(1);
  });
  it("keeps todo out of trace", () => { expect(executionActivities([tool("read", "read"), tool("todo", "todo"), tool("search", "grep")]).map((block) => block.id)).toEqual(["read", "search"]); });
});

describe("completed turn duration", () => {
  const toolWindow = (startedAt: string, endedAt: string): ToolCallBlock => ({ ...tool("read", "read"), startedAt, endedAt });

  it("uses the user-to-final-answer wall time instead of the tool write window", () => {
    render(<AgentActivity
      blocks={[toolWindow("2026-09-08T00:00:00.000Z", "2026-09-08T00:00:00.007Z")]}
      lifecycle="settled"
      hasFinalAnswer
      turnStartedAt="2026-09-08T00:00:00.000Z"
      turnEndedAt="2026-09-08T00:00:05.300Z"
    />);

    expect(screen.getByRole("button", { name: /Total turn duration: 5\.3s/ })).toHaveTextContent("Completed · 5.3s");
  });

  it("reports a whole turn that finished in under 100 ms as less than 0.1 seconds", () => {
    render(<AgentActivity
      blocks={[toolWindow("2026-09-08T00:00:00.000Z", "2026-09-08T00:00:00.007Z")]}
      lifecycle="settled"
      hasFinalAnswer
      turnStartedAt="2026-09-08T00:00:00.000Z"
      turnEndedAt="2026-09-08T00:00:00.007Z"
    />);

    expect(screen.getByRole("button", { name: /Total turn duration: <0\.1s/ })).toHaveTextContent("Completed · <0.1s");
  });

  it("labels the whole-turn duration in Simplified Chinese", async () => {
    await i18n.changeLanguage("zh-Hans");
    try {
      render(<AgentActivity
        blocks={[toolWindow("2026-09-08T00:00:00.000Z", "2026-09-08T00:00:00.007Z")]}
        lifecycle="settled"
        hasFinalAnswer
        turnStartedAt="2026-09-08T00:00:00.000Z"
        turnEndedAt="2026-09-08T00:00:05.300Z"
      />);

      expect(screen.getByRole("button", { name: /本轮总耗时：5\.3s/ })).toHaveTextContent("已完成 · 5.3s");
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it.each([
    ["2026-09-08T00:00:00.000Z", "2026-09-08T00:00:00.000Z"],
    ["2026-09-08T00:00:01.000Z", "2026-09-08T00:00:00.000Z"],
    ["not-a-timestamp", "2026-09-08T00:00:01.000Z"],
  ])("hides an untrusted boundary interval (%s -> %s)", (turnStartedAt, turnEndedAt) => {
    render(<AgentActivity blocks={[tool("read", "read")]} lifecycle="settled" hasFinalAnswer turnStartedAt={turnStartedAt} turnEndedAt={turnEndedAt} />);

    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByText(/0\.0s/)).not.toBeInTheDocument();
  });

  it("falls back to the tool window and labels it as the activity duration", () => {
    render(<AgentActivity blocks={[toolWindow("2026-09-08T00:00:00.000Z", "2026-09-08T00:00:00.007Z")]} lifecycle="aborted" />);

    expect(screen.getByRole("button", { name: /Activity duration: <0\.1s/ })).toHaveTextContent("Stopped · <0.1s");
  });

  it("shows the turn duration when the turn folded no activity away", () => {
    render(<AgentActivity blocks={[]} lifecycle="settled" hasFinalAnswer turnStartedAt="2026-09-08T00:00:00.000Z" turnEndedAt="2026-09-08T00:00:05.300Z" />);

    expect(screen.getByRole("status", { name: "Completed. Total turn duration: 5.3s" })).toHaveTextContent("Completed · 5.3s");
  });
});

describe("AgentActivity live stream", () => {
  it("uses semantic kernel and literature renderers", () => {
    render(<AgentActivity blocks={[
      { ...tool("python", "python", "done", { code: "print(42)" }), details: { outputs: [{ type: "text" }, { type: "image" }] } },
      { ...tool("pubmed", "search_pubmed", "done", { query: "kinetics" }), details: { results: [{}, {}, {}], retained: [{}] } },
    ]} />);
    expect(screen.getByText("Python")).toBeInTheDocument();
    expect(screen.getByText("2 outputs")).toBeInTheDocument();
    expect(screen.getByText("PubMed")).toBeInTheDocument();
    expect(screen.getByText("3 results · 1 retained")).toBeInTheDocument();
  });

  it("does not materialize expanded details while a trace row is collapsed", () => {
    const renderer = activityRendererRegistry.resolve("kernel");
    const expanded = vi.spyOn(renderer, "expanded");
    try {
      render(<AgentActivity blocks={[tool("python", "python")]} />);
      expect(expanded).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Python" }));
      expect(expanded).toHaveBeenCalledTimes(1);
    } finally {
      expanded.mockRestore();
    }
  });

  it("updates the running tool line immediately when consecutive tools share the same phase", () => {
    const read = tool("read", "read", "running", { path: "a.ts", description: "Find why the second reply stops following" });
    const { rerender } = render(<AgentActivity blocks={[read]} />);
    expect(screen.getByText("Reading a.ts")).toBeInTheDocument();
    rerender(<AgentActivity blocks={[{ ...read, status: "done" }, tool("next", "read", "running", { path: "b.ts", description: "Check how virtual list measurements update" })]} />);
    expect(screen.getByText("Working")).toBeInTheDocument();
    // Completed steps stay in the feed; the new running step appears below.
    expect(screen.getByText("Reading a.ts")).toBeInTheDocument();
    expect(screen.getByText("Reading b.ts")).toBeInTheDocument();
  });

  it("names a running tool that carries no task description", () => {
    render(<AgentActivity blocks={[tool("bash-1", "bash", "running")]} />);
    expect(screen.getByText("Running bash")).toBeInTheDocument();
    expect(screen.queryByText("Understanding your request and deciding what to do next")).not.toBeInTheDocument();
  });

  it("renders one exploration group summary for consecutive reads", () => {
    render(<AgentActivity blocks={[tool("r1", "read", "done", { path: "one.ts" }), tool("r2", "read", "done", { path: "two.ts" })]} />);
    expect(screen.getByText(/Exploring/)).toBeInTheDocument();
    expect(screen.getByText("Reading one.ts")).toBeInTheDocument();
    expect(screen.getByText("Reading two.ts")).toBeInTheDocument();
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

  it("shows a per-step duration for finished tools", () => {
    render(<AgentActivity blocks={[{ ...tool("t1", "bash", "done"), startedAt: "2026-09-08T00:00:00.000Z", endedAt: "2026-09-08T00:00:02.400Z" }]} />);
    expect(screen.getByText("2.4s")).toBeInTheDocument();
  });

  it("streams the live trace open with the status row pinned after it", () => {
    const { container } = render(<AgentActivity blocks={[tool("read", "read", "done", { path: "ConversationBlocks.tsx" }), tool("todo", "todo"), tool("search", "grep", "running", { pattern: "tool.updated" })]} />);
    // Status row: the phase title and timer only — the stream above already
    // carries every detail, so there is nothing to duplicate and nothing to
    // toggle.
    const title = screen.getByText("Working");
    const statusRow = title.closest("div[data-state]")!;
    expect(within(statusRow as HTMLElement).queryAllByRole("button")).toHaveLength(0);
    expect(container.firstElementChild).not.toHaveClass("border");
    expect(document.querySelector('[data-orb-variant="S4"]')).toBeInTheDocument();
    const trace = screen.getByLabelText("Execution trace");
    expect(within(trace).getByText("Reading ConversationBlocks.tsx")).toBeInTheDocument();
    expect(within(trace).getByText("Searching for tool.updated")).toBeInTheDocument();
  });

  it("keeps the active status visible for todo-only turns", () => { render(<AgentActivity blocks={[tool("todo", "todo")]} />); expect(screen.getByText("Working")).toBeInTheDocument(); expect(screen.queryByLabelText("Execution trace")).not.toBeInTheDocument(); });

  it.each(["settled", "aborted", "failed"] as const)("streams open through %s until the turn ends", (lifecycle) => {
    const blocks = [tool("read", "read", "running", { path: "a.ts" })];
    const { rerender, container } = render(<AgentActivity blocks={blocks} />);
    expect(screen.getByLabelText("Execution trace")).toBeInTheDocument();
    rerender(<AgentActivity blocks={[...blocks, tool("search", "grep", "running")]} lifecycle="waiting" />);
    expect(screen.getByLabelText("Execution trace")).toBeInTheDocument();
    rerender(<AgentActivity blocks={blocks} lifecycle="recovering" />);
    expect(screen.getByText("Resuming the task")).toBeInTheDocument();

    rerender(<AgentActivity blocks={blocks} lifecycle={lifecycle} />);
    // The stream ends with the turn: no trace region, no buttons.
    expect(screen.queryByLabelText("Execution trace")).not.toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).toBeNull();

    rerender(<AgentActivity blocks={blocks} lifecycle="active" />);
    expect(screen.getByLabelText("Execution trace")).toBeInTheDocument();
  });

  it("uses the generation narrative and orb for image generation", () => {
    render(<AgentActivity blocks={[tool("image", "image_gen", "running")]} />);
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(document.querySelector('[data-orb-variant="B3"]')).toBeInTheDocument();
  });

  it("uses the thinking pattern when a tool has no semantics", () => {
    render(<AgentActivity blocks={[tool("bash", "bash", "running", { command: "git status" })]} />);
    expect(screen.getByText("Running bash")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
  });

  it("holds implementation through test and corrective reads", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<AgentActivity blocks={[tool("read-1", "read", "running", { path: "first.ts" })]} />);
      expect(screen.getByText("Working")).toBeInTheDocument();
      rerender(<AgentActivity blocks={[tool("read-1", "read"), tool("edit", "edit", "running", { path: "a.ts" })]} />);
      act(() => { vi.advanceTimersByTime(900); });
      expect(screen.getByText("Working")).toBeInTheDocument();
      expect(document.querySelector('[data-orb-variant="B4"]')).toBeInTheDocument();
      rerender(<AgentActivity blocks={[tool("read-1", "read"), tool("edit", "edit"), tool("test", "bash", "running", { description: "Run tests" }), tool("corrective", "read", "running", { path: "a.ts" })]} />);
      act(() => { vi.advanceTimersByTime(900); });
      expect(screen.getByText("Working")).toBeInTheDocument();
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
      expect(screen.getByText("Working")).toBeInTheDocument();
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
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.queryByText("Encountered a problem")).not.toBeInTheDocument();
  });

  it("streams the reasoning row and folds the full reasoning behind it", () => {
    const thinking: ActivityBlock = { kind: "thinking", id: "th1", parts: [{ id: "th1-0", text: "Weigh the options.\nCheck the imports first." }], partial: true, startedAt: "2026-09-15T00:00:00.000Z" };
    const { rerender } = render(<AgentActivity blocks={[thinking]} />);
    // The freshest reasoning fragment streams at the row's right edge, exactly
    // like a running tool's output tail; earlier lines stay folded.
    expect(screen.getByText("Check the imports first.")).toBeInTheDocument();
    expect(screen.queryByText(/Weigh the options\./)).not.toBeInTheDocument();
    // The reasoning row's label and the status-row phase title share the word;
    // the phase title is the one inside the status marker row.
    expect(screen.getAllByText("Thinking").some((element) => element.closest("div[data-state]"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Thinking" }));
    expect(screen.getByText(/Weigh the options\./)).toBeInTheDocument();
    // Once narration takes over, the phase label falls back to the process.
    rerender(<AgentActivity blocks={[{ ...thinking, partial: false }, { kind: "agent", id: "a1", parts: [{ id: "a1-0", text: "Answer." }] }]} />);
    expect(screen.getByText("Working")).toBeInTheDocument();
  });

  it("shows a per-phase duration for finished reasoning", () => {
    const blocks: ActivityBlock[] = [
      { kind: "thinking", id: "th1", parts: [{ id: "th1-0", text: "Weigh the options." }], partial: false, startedAt: "2026-09-15T00:00:00.000Z", endedAt: "2026-09-15T00:00:03.200Z" },
      { kind: "agent", id: "a1", presentationRole: "final", parts: [{ id: "a1-0", text: "The final answer." }] },
    ];
    render(<AgentActivity blocks={blocks} lifecycle="settled" />);
    fireEvent.click(screen.getByText(/Complete|Encountered a problem|Stopped|Working/));
    expect(screen.getByText("3.2s")).toBeInTheDocument();
  });

  it("ticks the elapsed time of the reasoning phase while it runs", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-15T00:00:04.500Z"));
      const thinking: ActivityBlock = {
        kind: "thinking", id: "th1", parts: [{ id: "th1-0", text: "Weigh the options." }],
        partial: true, startedAt: "2026-09-15T00:00:00.000Z",
      };
      render(<AgentActivity blocks={[thinking]} />);
      // The running phase reports its own clock instead of waiting for the end
      // timestamp, so the reader can see how long the model has been thinking.
      expect(screen.getByText("4.5s")).toBeInTheDocument();

      act(() => {
        // The clock and the 250 ms tick both move forward: the chip follows.
        vi.setSystemTime(new Date("2026-09-15T00:00:06.400Z"));
        vi.advanceTimersByTime(500);
      });
      expect(screen.getByText("6.9s")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("folds reasoning into the settled step records", () => {
    const blocks: ActivityBlock[] = [
      { kind: "thinking", id: "th1", parts: [{ id: "th1-0", text: "Weigh the options." }] },
      tool("t1", "read", "done", { path: "a.ts" }),
      { kind: "agent", id: "a1", presentationRole: "final", parts: [{ id: "a1-0", text: "The final answer." }] },
    ];
    render(<AgentActivity blocks={blocks} lifecycle="settled" />);
    expect(screen.queryByText("Weigh the options.")).not.toBeInTheDocument();
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    // Expanding restores the complete pre-answer trajectory: the reasoning row
    // returns as a step, and its prose folds behind it like a tool's details.
    fireEvent.click(screen.getByText(/Complete|Encountered a problem|Stopped|Working/));
    expect(screen.getByText("Reading a.ts")).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.queryByText("Weigh the options.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Thinking" }));
    expect(screen.getByText("Weigh the options.")).toBeInTheDocument();
  });
  it("streams the freshest output line beside a running tool", () => {
    const bash = { ...tool("b1", "bash", "running", { command: "pip install -U scikit-learn" }), partialOutput: "Collecting scikit-learn\nDownloading numpy-1.26.4.whl (56 MB)\n" } as ToolCallBlock;
    const { rerender } = render(<AgentActivity blocks={[bash]} />);
    expect(screen.getByText("Downloading numpy-1.26.4.whl (56 MB)")).toBeInTheDocument();
    // Once the step completes, the tail makes way for the duration chip.
    rerender(<AgentActivity blocks={[{ ...bash, status: "done", output: "Installed", startedAt: "2026-09-09T00:00:00.000Z", endedAt: "2026-09-09T00:00:01.900Z" }]} />);
    expect(screen.queryByText("Downloading numpy-1.26.4.whl (56 MB)")).not.toBeInTheDocument();
    expect(screen.getByText("1.9s")).toBeInTheDocument();
  });

  it("shows interaction, failure, and abort lifecycle copy", () => {
    const { rerender } = render(<AgentActivity lifecycle="waiting" blocks={[tool("read", "read"), tool("ask", "ask_user_question", "waiting-approval")]} />);
    expect(screen.getByText("Needs your input")).toBeInTheDocument();
    rerender(<AgentActivity lifecycle="failed" blocks={[tool("failed", "bash", "error", { description: "Run tests" })]} />);
    expect(screen.getByText("Encountered a problem")).toBeInTheDocument();
    rerender(<AgentActivity lifecycle="aborted" blocks={[tool("read", "read")]} />);
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  it("switches away from a resolved running interaction immediately", () => {
    const waiting = tool("ask", "ask_user_question", "running");
    const { rerender } = render(<AgentActivity lifecycle="waiting" blocks={[tool("read", "read"), waiting]} />);
    expect(screen.getByText("Needs your input")).toBeInTheDocument();

    rerender(<AgentActivity lifecycle="active" blocks={[tool("read", "read"), { ...waiting, interactionResolved: true }]} />);
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.queryByText("Needs your input")).not.toBeInTheDocument();
  });
});

describe("AgentActivity settled display", () => {
  it("folds intermediate narration with the step records and leaves final answers outside activity", () => {
    const blocks = [
      { kind: "agent" as const, id: "a1", presentationRole: "intermediate" as const, parts: [{ id: "p1", text: "Step notes: the CSV has 4 columns." }] },
      tool("t1", "read", "done", { path: "one.ts" }),
      tool("t2", "bash", "done"),
      { kind: "agent" as const, id: "a2", presentationRole: "final" as const, parts: [{ id: "p2", text: "The final answer." }] },
    ];
    render(<AgentActivity blocks={blocks} lifecycle="settled" />);

    // Settled activity starts compact: commentary, reasoning, and tools are
    // process history; the final answer belongs to ConversationTurn instead.
    expect(screen.queryByText("Step notes: the CSV has 4 columns.")).not.toBeInTheDocument();
    expect(screen.queryByText("The final answer.")).not.toBeInTheDocument();
    expect(screen.queryByText("Reading one.ts")).not.toBeInTheDocument();
    expect(screen.queryByText("Running bash")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Execution trace")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/Complete|Encountered a problem|Stopped|Working/));
    expect(screen.getByText("Step notes: the CSV has 4 columns.")).toBeInTheDocument();
    expect(screen.getByText("Reading one.ts")).toBeInTheDocument();
    expect(screen.getByText("Running bash")).toBeInTheDocument();
    expect(screen.queryByText("The final answer.")).not.toBeInTheDocument();
  });

  it("shows elapsed time for a completed reasoning phase without tool calls", () => {
    render(<AgentActivity lifecycle="settled" blocks={[{
      kind: "thinking", id: "reasoning", parts: [{ id: "reasoning-part", text: "Check the result" }],
      startedAt: "2026-09-08T00:00:00.000Z", endedAt: "2026-09-08T00:00:03.400Z",
    }]} />);
    expect(screen.getByRole("button", { name: /Completed · 3.4s/ })).toBeInTheDocument();
  });

  it("uses the conversation timestamps when restored activity has no tool timing", () => {
    render(<AgentActivity lifecycle="settled" turnStartedAt="2026-09-08T00:00:00.000Z" turnEndedAt="2026-09-08T00:00:05.200Z" blocks={[{
      kind: "agent", id: "update", presentationRole: "intermediate", parts: [{ id: "update-part", text: "Checking." }],
    }]} />);
    expect(screen.getByRole("button", { name: /Completed · 5.2s/ })).toBeInTheDocument();
  });

  it("folds commentary when a settled turn never produced a final answer", () => {
    render(<AgentActivity lifecycle="settled" blocks={[{ kind: "agent", id: "commentary", presentationRole: "intermediate", parts: [{ id: "commentary-part", text: "I checked the inputs." }] }]} />);

    expect(screen.queryByText("I checked the inputs.")).not.toBeInTheDocument();
    expect(screen.getByText(/No final answer returned/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("I checked the inputs.")).toBeInTheDocument();
  });

  it("exposes structured tool details even when there is no text output", () => {
    render(<AgentActivity lifecycle="settled" blocks={[{ ...tool("structured", "compute"), output: undefined, details: { rows: 3 } }]} />);
    fireEvent.click(screen.getByText(/Complete|Encountered a problem|Stopped|Working/));
    fireEvent.click(screen.getByText("Running compute"));
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText(/"rows": 3/)).toBeInTheDocument();
  });

  it("keeps the state headline for aborted and failed turns", () => {
    const { rerender } = render(<AgentActivity lifecycle="failed" blocks={[tool("failed", "bash", "error", { description: "Run tests" })]} />);
    expect(screen.getByText("Encountered a problem")).toBeInTheDocument();
    rerender(<AgentActivity lifecycle="aborted" blocks={[tool("read", "read")]} />);
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });
});
