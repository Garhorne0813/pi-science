import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { emptyThread } from "@/lib/agent-runtime/event-fold";
import i18n from "@/i18n";
import type { ThreadBlock } from "@/types/thread";
import { ComposerTodo } from "./ComposerTodo";

function todoBlock(tasks: unknown[]): ThreadBlock {
  return {
    kind: "tool",
    id: "tool-t1",
    callId: "t1",
    tool: "todo",
    status: "done",
    details: { tasks, nextId: tasks.length + 1 },
  };
}

function setTasks(tasks: unknown[]) {
  useRuntimeStore.setState({
    thread: { blocks: [todoBlock(tasks)], index: {}, loaded: true },
  });
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  useRuntimeStore.setState({ thread: { ...emptyThread(), loaded: true } });
});

afterEach(() => {
  cleanup();
});

describe("ComposerTodo", () => {
  it("renders only for an unfinished task list", () => {
    const { container, rerender } = render(<ComposerTodo />);
    expect(container).toBeEmptyDOMElement();

    act(() => setTasks([{ id: 1, subject: "Load", status: "completed" }]));
    rerender(<ComposerTodo />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the active task's actual position in a compact capsule", () => {
    setTasks([
      { id: 1, subject: "Load", status: "completed" },
      { id: 2, subject: "Prepare", status: "pending" },
      { id: 3, subject: "Fit", status: "in_progress", activeForm: "Fitting model" },
    ]);
    render(<ComposerTodo />);

    expect(screen.getByText("3 / 3")).toBeInTheDocument();
    expect(screen.getByText("Fitting model")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "33");
    expect(screen.queryByRole("region", { name: "Task list" })).not.toBeInTheDocument();
  });

  it("previews on hover and disappears after the pointer leaves", () => {
    setTasks([
      { id: 1, subject: "Load", status: "in_progress" },
      { id: 2, subject: "Fit", status: "pending" },
    ]);
    render(<ComposerTodo />);
    const trigger = screen.getByRole("button", { name: /Task list/ });
    const hoverRegion = trigger.parentElement!;

    fireEvent.mouseEnter(hoverRegion);
    expect(screen.getByRole("region", { name: "Task list" })).toBeInTheDocument();

    fireEvent.mouseLeave(hoverRegion);
    expect(screen.queryByRole("region", { name: "Task list" })).not.toBeInTheDocument();
  });

  it("keeps the preview open while moving from the capsule into the list", () => {
    setTasks([{ id: 1, subject: "Load", status: "in_progress" }]);
    render(<ComposerTodo />);
    const trigger = screen.getByRole("button", { name: /Task list/ });
    const hoverRegion = trigger.parentElement!;

    fireEvent.mouseEnter(hoverRegion);
    const preview = screen.getByRole("region", { name: "Task list" });
    fireEvent.mouseEnter(preview);
    expect(preview).toBeInTheDocument();
    expect(hoverRegion).toContainElement(preview);
    expect(preview).toHaveClass("pb-2");
  });

  it("opens on keyboard focus and closes on Escape", () => {
    setTasks([{ id: 1, subject: "Load", status: "in_progress" }]);
    render(<ComposerTodo />);
    const trigger = screen.getByRole("button", { name: /Task list/ });

    fireEvent.focus(trigger);
    expect(screen.getByRole("region", { name: "Task list" })).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Task list" })).not.toBeInTheDocument();
  });
});
