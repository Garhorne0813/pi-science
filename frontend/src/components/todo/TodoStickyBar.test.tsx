import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { emptyThread } from "@/lib/agent-runtime/event-fold";
import { useUiStore } from "@/lib/ui";
import i18n from "@/i18n";
import type { ThreadBlock } from "@/types/thread";
import { TodoStickyBar } from "./TodoStickyBar";
import { TodoWidget } from "./TodoWidget";

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
  useRuntimeStore.setState({ thread: { ...emptyThread(), loaded: true }, cwd: "proj", activeSessionId: "s1" });
  useUiStore.setState({ todoUiMode: "sticky", todoUiOpen: false });
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

  it("floats over the thread as an absolute overlay without taking layout space", () => {
    setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "pending" }] })]);
    const { container } = render(<TodoStickyBar />);
    const overlay = container.firstElementChild;
    expect(overlay).not.toBeNull();
    expect(overlay!.className).toContain("absolute");
    expect(overlay!.className).toContain("z-30");
    expect(overlay!.className).toContain("inset-x-3");
    expect(overlay!.className).toContain("max-w-[760px]");
    expect(overlay!.className).not.toContain("100vw");
    // A restored list starts collapsed; opening it expands below the bar.
    expect(document.getElementById("todo-sticky-list")).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    const panel = document.getElementById("todo-sticky-list");
    expect(panel).not.toBeNull();
    expect(panel!.className).toContain("absolute");
    expect(panel!.className).toContain("top-full");
    expect(panel!.className).toContain("overflow-y-auto");
    expect(panel!.className).toContain("p-compact");
    expect(panel!.querySelector("ul")!.className).toContain("space-y-0.5");
    expect(panel!.querySelector("li")!.className).toContain("py-compact");
  });

  it("renders nothing without todo tasks", () => {
    const { container } = render(<TodoStickyBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders progress, count, active task form and auto-expands once", () => {
    render(<TodoStickyBar />);
    act(() => setThread([todoBlock({
      action: "create",
      nextId: 3,
      tasks: [
        { id: 1, subject: "Load", status: "completed" },
        { id: 2, subject: "Fit", status: "in_progress", activeForm: "正在拟合模型" },
      ],
    })]));
    // A newly-created list in the loaded conversation auto-expands.
    expect(screen.getByText("Load")).toBeInTheDocument();
    expect(screen.getByText("Fit")).toBeInTheDocument();
    expect(screen.getByText("50% · 1/2")).toBeInTheDocument();
    expect(screen.getByText("正在拟合模型")).toBeInTheDocument();
    const progress = screen.getByRole("progressbar");
    expect(progress).toHaveAttribute("aria-valuenow", "50");
  });

  it("toggles the list on click and respects a user close for the streak", () => {
    render(<TodoStickyBar />);
    act(() => setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "pending" }] })]));
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
    render(<TodoStickyBar />);
    act(() => setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "pending" }] })]));
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    act(() => setThread([]));
    expect(document.getElementById("todo-sticky-list")).toBeNull();
    act(() => setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Second", status: "pending" }] })]));
    expect(document.getElementById("todo-sticky-list")).not.toBeNull();
    expect(screen.getAllByText("Second").length).toBeGreaterThan(0);
  });

  it("collapses on Escape", () => {
    render(<TodoStickyBar />);
    act(() => setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "pending" }] })]));
    expect(document.getElementById("todo-sticky-list")).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { expanded: true }), { key: "Escape" });
    expect(document.getElementById("todo-sticky-list")).toBeNull();
  });

  it("switches to fab mode via the mode switch", () => {
    setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "pending" }] })]);
    render(<TodoStickyBar />);
    fireEvent.click(screen.getByRole("button", { name: /Minimize/ }));
    expect(useUiStore.getState().todoUiMode).toBe("fab");
  });

  it("keeps a collapsed list collapsed when minimizing to fab mode", () => {
    setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "pending" }] })]);
    render(<>
      <TodoStickyBar />
      <TodoWidget />
    </>);

    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Minimize/ }));

    const fab = screen.getByRole("progressbar", { name: "Task list" }).closest("button")!;
    expect(fab).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("hides when every task is completed", () => {
    setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "completed" }] })]);
    const { container } = render(<TodoStickyBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("auto-opens again when a new task appears after completion", () => {
    setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "First", status: "completed" }] })]);
    render(<TodoStickyBar />);
    expect(screen.queryByText("First")).not.toBeInTheDocument();

    act(() => setThread([todoBlock({ action: "create", nextId: 3, tasks: [
      { id: 1, subject: "First", status: "completed" },
      { id: 2, subject: "Second", status: "pending" },
    ] })]));

    expect(screen.getAllByText("Second").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
  });
});
