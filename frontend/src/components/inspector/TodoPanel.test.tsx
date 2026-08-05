import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { emptyThread } from "@/lib/agent-runtime/event-fold";
import i18n from "@/i18n";
import { TodoPanel } from "./TodoPanel";

describe("TodoPanel", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  beforeEach(() => {
    useRuntimeStore.setState({ thread: emptyThread() });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing when the conversation has no todo tool results", () => {
    useRuntimeStore.setState({
      thread: {
        ...emptyThread(),
        blocks: [{ kind: "user", id: "u1", text: "hello" }],
      },
    });
    const { container } = render(<TodoPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the visible task list with status badges and counts", () => {
    useRuntimeStore.setState({
      thread: {
        ...emptyThread(),
        blocks: [{
          kind: "tool",
          id: "tool-t1",
          callId: "t1",
          tool: "todo",
          status: "done",
          details: {
            action: "create",
            params: {},
            nextId: 3,
            tasks: [
              { id: 1, subject: "Load dataset", status: "completed" },
              { id: 2, subject: "Fit model", status: "in_progress", description: "GBM on X", owner: "me" },
              { id: 3, subject: "Write report", status: "pending", blockedBy: [2] },
              { id: 4, subject: "Old idea", status: "deleted" },
            ],
          },
        }],
      },
    });
    render(<TodoPanel />);

    expect(screen.getByRole("heading", { name: "Task list" })).toBeInTheDocument();
    // deleted tombstones are hidden; count shows non-completed / total visible
    expect(screen.getByText("2/3")).toBeInTheDocument();
    expect(screen.getByText("Load dataset")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("GBM on X")).toBeInTheDocument();
    expect(screen.getByText("Owner: me")).toBeInTheDocument();
    expect(screen.getByText("Depends on #2")).toBeInTheDocument();
    expect(screen.queryByText("Old idea")).not.toBeInTheDocument();
  });

  it("shows the newest snapshot when multiple todo results exist", () => {
    useRuntimeStore.setState({
      thread: {
        ...emptyThread(),
        blocks: [
          {
            kind: "tool", id: "tool-t1", callId: "t1", tool: "todo", status: "done",
            details: { action: "create", params: {}, nextId: 2, tasks: [{ id: 1, subject: "Old title", status: "pending" }] },
          },
          {
            kind: "tool", id: "tool-t2", callId: "t2", tool: "todo", status: "done",
            details: { action: "update", params: {}, nextId: 2, tasks: [{ id: 1, subject: "New title", status: "in_progress" }] },
          },
        ],
      },
    });
    render(<TodoPanel />);
    expect(screen.getByText("New title")).toBeInTheDocument();
    expect(screen.queryByText("Old title")).not.toBeInTheDocument();
  });
});
