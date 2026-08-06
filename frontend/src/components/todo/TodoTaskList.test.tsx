import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useRuntimeStore } from "@/lib/agent-runtime";
import { emptyThread } from "@/lib/agent-runtime/event-fold";
import i18n from "@/i18n";
import { TodoTaskList } from "./TodoTaskList";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  useRuntimeStore.setState({ thread: emptyThread() });
});

afterEach(() => {
  cleanup();
});

const tasks = [
  { id: 1, subject: "Load dataset", status: "completed" as const },
  { id: 2, subject: "Fit model", status: "in_progress" as const, description: "GBM on X", activeForm: "正在拟合模型", owner: "me" },
  { id: 3, subject: "Write report", status: "pending" as const, blockedBy: [2] },
  { id: 4, subject: "Unblocked report", status: "pending" as const, blockedBy: [1] },
];

describe("TodoTaskList", () => {
  it("renders every task with status labels and description/owner", () => {
    render(<TodoTaskList tasks={tasks} />);
    expect(screen.getByText("Load dataset")).toBeInTheDocument();
    expect(screen.getByText("Fit model")).toBeInTheDocument();
    expect(screen.getByText("Write report")).toBeInTheDocument();
    expect(screen.getAllByText("Completed")).toHaveLength(1);
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("GBM on X")).toBeInTheDocument();
    expect(screen.getByText("Owner: me")).toBeInTheDocument();
  });

  it("marks a task blocked only when its dependency is unfinished", () => {
    render(<TodoTaskList tasks={tasks} />);
    // Task 3 depends on task 2 (in_progress) -> blocked warning shown.
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("Depends on #2")).toBeInTheDocument();
    // Task 4 depends on task 1 (completed) -> no blocked warning, but the
    // dependency line is still shown.
    expect(screen.getByText("Depends on #1")).toBeInTheDocument();
    expect(screen.getAllByText("Blocked")).toHaveLength(1);
  });
});
