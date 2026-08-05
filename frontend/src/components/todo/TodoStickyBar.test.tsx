import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { emptyThread } from "@/lib/agent-runtime/event-fold";
import { useUiStore } from "@/lib/ui";
import i18n from "@/i18n";
import type { ThreadBlock } from "@/types/thread";
import { TodoStickyBar } from "./TodoStickyBar";

function todoBlock(details: unknown): ThreadBlock {
  return {
    kind: "tool",
    id: "tool-t1",
    callId: "t1",
    tool: "todo",
    status: "done",
    details,
  };
}

function setThread(blocks: ThreadBlock[]) {
  useRuntimeStore.setState({ thread: { blocks, index: {}, loaded: true } });
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  useRuntimeStore.setState({ thread: emptyThread(), cwd: "proj", activeSessionId: "s1" });
  useUiStore.setState({ todoUiMode: "sticky" });
});

afterEach(() => {
  cleanup();
});

describe("TodoStickyBar", () => {
  it("renders nothing in fab mode", () => {
    useUiStore.setState({ todoUiMode: "fab" });
    setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "pending" }] })]);
    const { container } = render(<TodoStickyBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing without todo tasks", () => {
    const { container } = render(<TodoStickyBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders progress, count, active task form and auto-expands once", () => {
    setThread([todoBlock({
      action: "create",
      nextId: 3,
      tasks: [
        { id: 1, subject: "Load", status: "completed" },
        { id: 2, subject: "Fit", status: "in_progress", activeForm: "正在拟合模型" },
      ],
    })]);
    render(<TodoStickyBar />);
    // Auto-expanded on mount: task list visible.
    expect(screen.getByText("Load")).toBeInTheDocument();
    expect(screen.getByText("Fit")).toBeInTheDocument();
    expect(screen.getByText("50% · 1/2")).toBeInTheDocument();
    expect(screen.getByText("正在拟合模型")).toBeInTheDocument();
    const progress = screen.getByRole("progressbar");
    expect(progress).toHaveAttribute("aria-valuenow", "50");
  });

  it("toggles the list on click and respects a user close for the streak", () => {
    setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "pending" }] })]);
    render(<TodoStickyBar />);
    const toggle = screen.getByRole("button", { expanded: true });
    fireEvent.click(toggle);
    expect(document.getElementById("todo-sticky-list")).toBeNull();
    // Same streak: must not auto-reopen on a later snapshot update.
    act(() => setThread([todoBlock({ action: "update", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "in_progress" }] })]));
    expect(document.getElementById("todo-sticky-list")).toBeNull();
    // Manual reopen still works.
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(document.getElementById("todo-sticky-list")).not.toBeNull();
  });

  it("reopens for a new streak after all todos disappear", () => {
    setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "pending" }] })]);
    render(<TodoStickyBar />);
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    act(() => setThread([]));
    expect(document.getElementById("todo-sticky-list")).toBeNull();
    act(() => setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Second", status: "pending" }] })]));
    expect(document.getElementById("todo-sticky-list")).not.toBeNull();
    expect(screen.getAllByText("Second").length).toBeGreaterThan(0);
  });

  it("collapses on Escape", () => {
    setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "pending" }] })]);
    render(<TodoStickyBar />);
    expect(document.getElementById("todo-sticky-list")).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { expanded: true }), { key: "Escape" });
    expect(document.getElementById("todo-sticky-list")).toBeNull();
  });

  it("switches to fab mode via the mode switch", () => {
    setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "pending" }] })]);
    render(<TodoStickyBar />);
    fireEvent.click(screen.getByRole("button", { name: /Floating mode/ }));
    expect(useUiStore.getState().todoUiMode).toBe("fab");
  });

  it("shows All done when every task is completed", () => {
    setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "completed" }] })]);
    render(<TodoStickyBar />);
    expect(screen.getByText("All done")).toBeInTheDocument();
    expect(screen.getByText("100% · 1/1")).toBeInTheDocument();
  });
});
