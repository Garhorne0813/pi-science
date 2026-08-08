import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { emptyThread } from "@/lib/agent-runtime/event-fold";
import { useUiStore } from "@/lib/ui";
import i18n from "@/i18n";
import type { ThreadBlock } from "@/types/thread";
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
  useRuntimeStore.setState({ thread: emptyThread(), cwd: "proj", activeSessionId: "s1" });
  useUiStore.setState({ todoUiMode: "fab" });
  localStorage.removeItem("pi-science.todo-widget-position");
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
  Reflect.deleteProperty(HTMLElement.prototype, "hasPointerCapture");
  Reflect.deleteProperty(HTMLElement.prototype, "releasePointerCapture");
});

describe("TodoWidget", () => {
  it("renders nothing in sticky mode or without todos", () => {
    useUiStore.setState({ todoUiMode: "sticky" });
    setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "pending" }] })]);
    const { container } = render(<TodoWidget />);
    expect(container).toBeEmptyDOMElement();
    useUiStore.setState({ todoUiMode: "fab" });
    setThread([]);
    cleanup();
    const second = render(<TodoWidget />);
    expect(second.container).toBeEmptyDOMElement();
  });

  it("renders the FAB with progress and auto-expands the card once on mount", () => {
    setThread([todoBlock({
      action: "create",
      nextId: 3,
      tasks: [
        { id: 1, subject: "Load", status: "completed" },
        { id: 2, subject: "Fit", status: "in_progress", activeForm: "正在拟合模型" },
      ],
    })]);
    render(<TodoWidget />);
    expect(screen.getAllByText("50% · 1/2").length).toBeGreaterThan(0);
    // Auto-expanded: the task list is in the popover content.
    expect(screen.getByText("Load")).toBeInTheDocument();
    expect(screen.getByText("Fit")).toBeInTheDocument();
    const popover = screen.getByRole("dialog");
    expect(popover).toHaveClass("w-[min(320px,calc(100vw-24px))]");
    expect(popover.querySelector("ul")).toHaveClass("space-y-0.5");
    expect(popover.querySelector("li")).toHaveClass("py-1.5");
  });

  it("closes the card on Escape and does not reopen during the same streak", async () => {
    setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "pending" }] })]);
    render(<TodoWidget />);
    expect(screen.getAllByText("Load").length).toBeGreaterThan(0);
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryAllByText("Load")).toHaveLength(1));
    // Same streak: a snapshot update must not reopen it.
    act(() => setThread([todoBlock({ action: "update", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "in_progress" }] })]));
    await waitFor(() => expect(screen.queryAllByText("Load")).toHaveLength(1));
  });

  it("reopens for a new streak after all todos disappear", async () => {
    setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "pending" }] })]);
    render(<TodoWidget />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryAllByText("Load")).toHaveLength(1));
    act(() => setThread([]));
    act(() => setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Second", status: "pending" }] })]));
    expect(screen.getAllByText("Second").length).toBeGreaterThan(0);
  });

  it("switches to sticky mode via the mode switch", async () => {
    setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "pending" }] })]);
    render(<TodoWidget />);
    fireEvent.click(screen.getByRole("button", { name: /Sticky mode/ }));
    expect(useUiStore.getState().todoUiMode).toBe("sticky");
  });

  it("drags within the conversation area, persists the position, and suppresses the drag click", async () => {
    let captured = false;
    Object.defineProperties(HTMLElement.prototype, {
      setPointerCapture: { configurable: true, value: () => { captured = true; } },
      hasPointerCapture: { configurable: true, value: () => captured },
      releasePointerCapture: { configurable: true, value: () => { captured = false; } },
    });
    setThread([todoBlock({ action: "create", nextId: 2, tasks: [{ id: 1, subject: "Load", status: "pending" }] })]);
    render(<TodoWidget />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    const trigger = screen.getByRole("progressbar", { name: "Task list" }).closest("button")!;
    Object.defineProperty(trigger.parentElement, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 500, height: 400, right: 500, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }),
    });
    Object.defineProperty(trigger, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 380, top: 340, width: 100, height: 40, right: 480, bottom: 380, x: 380, y: 340, toJSON: () => ({}) }),
    });

    fireEvent.pointerDown(trigger, { button: 0, pointerId: 1, clientX: 400, clientY: 350 });
    fireEvent.pointerMove(trigger, { pointerId: 1, clientX: 300, clientY: 250 });
    fireEvent.pointerUp(trigger, { pointerId: 1, clientX: 300, clientY: 250 });
    fireEvent.click(trigger);

    expect(trigger).toHaveStyle({ left: "280px", top: "240px" });
    expect(JSON.parse(localStorage.getItem("pi-science.todo-widget-position")!)).toEqual({ left: 280, top: 240 });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
