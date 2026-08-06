import { describe, expect, it } from "vitest";
import type { ThreadBlock } from "../../types/thread";
import { extractTodoSnapshot, visibleTasks } from "./todos";

function todoBlock(details: unknown, overrides: Partial<Extract<ThreadBlock, { kind: "tool" }>> = {}): ThreadBlock {
  const block: Extract<ThreadBlock, { kind: "tool" }> = {
    kind: "tool",
    id: `tool-${overrides.callId ?? "c1"}`,
    callId: overrides.callId ?? "c1",
    tool: "todo",
    status: "done",
    details,
    ...overrides,
  };
  return block;
}

const tasksV1 = [
  { id: 1, subject: "Load dataset", status: "completed" },
  { id: 2, subject: "Fit model", status: "in_progress" },
];

const tasksV2 = [
  { id: 1, subject: "Load dataset", status: "completed" },
  { id: 2, subject: "Fit model", status: "completed" },
  { id: 3, subject: "Write report", status: "pending", blockedBy: [2], owner: "me" },
];

describe("extractTodoSnapshot", () => {
  it("returns null when no todo tool result exists", () => {
    const blocks: ThreadBlock[] = [
      { kind: "user", id: "u1", text: "hello" },
      { kind: "tool", id: "tool-b", callId: "b", tool: "read", status: "done", output: "ok" },
    ];
    expect(extractTodoSnapshot(blocks)).toBeNull();
  });

  it("takes the last snapshot when multiple todo results exist (last-write-wins)", () => {
    const blocks = [
      todoBlock({ tasks: tasksV1, nextId: 3 }, { callId: "c1" }),
      todoBlock({ tasks: tasksV2, nextId: 4 }, { callId: "c2" }),
    ];
    const snapshot = extractTodoSnapshot(blocks);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.nextId).toBe(4);
    expect(snapshot!.tasks).toHaveLength(3);
    expect(snapshot!.tasks[2]).toMatchObject({ subject: "Write report", status: "pending", blockedBy: [2], owner: "me" });
  });

  it("ignores non-todo tool blocks and interleaved blocks in between", () => {
    const blocks: ThreadBlock[] = [
      { kind: "user", id: "u1", text: "go" },
      todoBlock({ tasks: tasksV1, nextId: 3 }, { callId: "c1" }),
      { kind: "tool", id: "tool-r", callId: "r", tool: "read", status: "done", output: "ok" },
      todoBlock({ tasks: tasksV2, nextId: 4 }, { callId: "c2" }),
    ];
    const snapshot = extractTodoSnapshot(blocks);
    expect(snapshot!.tasks).toHaveLength(3);
  });

  it("keeps error results as the latest committed state", () => {
    const blocks = [
      todoBlock({ tasks: tasksV1, nextId: 3 }, { callId: "c1" }),
      todoBlock({ action: "update", params: {}, tasks: tasksV1, nextId: 3, error: "unknown id 99" }, { callId: "c2", status: "error" }),
    ];
    const snapshot = extractTodoSnapshot(blocks);
    expect(snapshot!.tasks).toHaveLength(2);
    expect(snapshot!.tasks[0].subject).toBe("Load dataset");
  });

  it("returns null when details are missing or malformed", () => {
    expect(extractTodoSnapshot([todoBlock(undefined)])).toBeNull();
    expect(extractTodoSnapshot([todoBlock({ tasks: "nope" })])).toBeNull();
    expect(extractTodoSnapshot([todoBlock({})])).toBeNull();
  });
});

describe("visibleTasks", () => {
  it("hides deleted tombstones but keeps the rest", () => {
    const snapshot = {
      nextId: 5,
      tasks: [
        { id: 1, subject: "a", status: "completed" as const },
        { id: 2, subject: "b", status: "deleted" as const },
        { id: 3, subject: "c", status: "pending" as const },
      ],
    };
    expect(visibleTasks(snapshot).map((task) => task.id)).toEqual([1, 3]);
  });
});

import { todoViewModel } from "./todos";

describe("todoViewModel", () => {
  it("returns null when the thread has no visible todo tasks", () => {
    expect(todoViewModel([{ kind: "user", id: "u1", text: "hi" }])).toBeNull();
    expect(todoViewModel([todoBlock({ tasks: [{ id: 1, subject: "x", status: "deleted" }], nextId: 2 })])).toBeNull();
  });

  it("computes totals, percent and allCompleted", () => {
    const vm = todoViewModel([
      todoBlock({
        nextId: 4,
        tasks: [
          { id: 1, subject: "Load", status: "completed" },
          { id: 2, subject: "Fit", status: "completed" },
          { id: 3, subject: "Report", status: "pending" },
          { id: 4, subject: "Gone", status: "deleted" },
        ],
      }),
    ]);
    expect(vm).not.toBeNull();
    expect(vm!.total).toBe(3);
    expect(vm!.completed).toBe(2);
    expect(vm!.percent).toBe(67);
    expect(vm!.allCompleted).toBe(false);
  });

  it("prefers in_progress over pending for the active task and uses subject", () => {
    const vm = todoViewModel([todoBlock({
      nextId: 3,
      tasks: [
        { id: 1, subject: "Load", status: "completed" },
        { id: 2, subject: "Fit", status: "pending" },
      ],
    })]);
    expect(vm!.activeTask).toMatchObject({ id: 2, subject: "Fit" });
  });

  it("counts only tasks blocked by unfinished dependencies", () => {
    const vm = todoViewModel([todoBlock({
      nextId: 5,
      tasks: [
        { id: 1, subject: "A", status: "completed" },
        { id: 2, subject: "B", status: "pending", blockedBy: [1] },
        { id: 3, subject: "C", status: "pending", blockedBy: [1, 2] },
        { id: 4, subject: "D", status: "in_progress", blockedBy: [99] },
      ],
    })]);
    // B depends on completed A -> not blocked. C depends on B (pending) -> blocked.
    // D depends on a missing id -> not counted.
    expect(vm!.blockedCount).toBe(1);
  });

  it("reports allCompleted when every visible task is completed", () => {
    const vm = todoViewModel([todoBlock({
      nextId: 3,
      tasks: [
        { id: 1, subject: "A", status: "completed" },
        { id: 2, subject: "B", status: "completed" },
      ],
    })]);
    expect(vm!.allCompleted).toBe(true);
    expect(vm!.percent).toBe(100);
    expect(vm!.activeTask).toBeNull();
  });
});
