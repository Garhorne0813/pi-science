/** Todo task snapshot extraction from the conversation thread.
 *
 *  The `todo` tool (rpiv-todo extension) persists its full task list inside
 *  each toolResult message's `details` field (last-write-wins per branch).
 *  There are no live web events for todo state, so the Inspector panel
 *  rebuilds the current list by scanning the tool blocks already folded into
 *  the thread and taking the newest snapshot. */

import type { ThreadBlock } from "../../types/thread";

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface TodoTask {
  id: number;
  subject: string;
  description?: string;
  status: TodoStatus;
  /** Ids of tasks this task depends on (from the rpiv-todo dependency graph). */
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
  /** rpiv-todo keeps the active form for in-progress tasks. */
  activeForm?: string;
}

export interface TodoSnapshot {
  tasks: TodoTask[];
  nextId: number;
}

/** Task list as emitted by the rpiv-todo tool result envelope. */
interface TodoToolDetails {
  action?: unknown;
  tasks?: unknown;
  nextId?: unknown;
  error?: unknown;
}

function snapshotFromDetails(details: TodoToolDetails): TodoSnapshot {
  return {
    tasks: details.tasks as TodoTask[],
    nextId: typeof details.nextId === "number" ? details.nextId : 1,
  };
}

/** Newest todo snapshot in the thread, or null when the conversation has no
 *  todo tool result yet. Error results still carry the committed state (the
 *  reducer commits before the envelope is built), so they are kept. */
export function extractTodoSnapshot(blocks: ThreadBlock[]): TodoSnapshot | null {
  let snapshot: TodoSnapshot | null = null;
  for (const block of blocks) {
    if (block.kind !== "tool" || block.tool !== "todo") continue;
    const details = block.details as TodoToolDetails | undefined;
    if (!details || !Array.isArray(details.tasks)) continue;
    snapshot = snapshotFromDetails(details);
  }
  return snapshot;
}

/** Latest logical task batch in the thread.
 *
 * rpiv-todo persists one cumulative task array and creates a multi-task plan
 * through several consecutive `create` calls. For presentation we start a new
 * batch at the first successful create after a user message, or whenever a
 * create follows a fully-completed list. Further creates in that same turn are
 * appended to the new batch. This keeps separate plans from being displayed as
 * one ever-growing list without changing the tool's persisted state. */
export function extractLatestTodoBatchSnapshot(blocks: ThreadBlock[]): TodoSnapshot | null {
  let latest: TodoSnapshot | null = null;
  let batchIds = new Set<number>();
  let createdInCurrentTurn = false;

  for (const block of blocks) {
    if (block.kind === "user") {
      createdInCurrentTurn = false;
      continue;
    }
    if (block.kind !== "tool" || block.tool !== "todo") continue;
    const details = block.details as TodoToolDetails | undefined;
    if (!details || !Array.isArray(details.tasks)) continue;

    const current = snapshotFromDetails(details);
    const previous = latest;
    latest = current;

    if (details.action === "clear" || current.tasks.length === 0) {
      batchIds = new Set();
      continue;
    }

    if (details.action !== "create") continue;
    const previousIds = new Set(previous?.tasks.map((task) => task.id) ?? []);
    const createdIds = current.tasks
      .filter((task) => !previousIds.has(task.id) && task.status !== "deleted")
      .map((task) => task.id);
    if (createdIds.length === 0) continue;

    const previousVisible = previous ? visibleTasks(previous) : [];
    const previousAllCompleted = previousVisible.length > 0
      && previousVisible.every((task) => task.status === "completed");
    if (batchIds.size > 0 && (!createdInCurrentTurn || previousAllCompleted)) {
      batchIds = new Set(createdIds);
    } else {
      for (const id of createdIds) batchIds.add(id);
    }
    createdInCurrentTurn = true;
  }

  if (!latest) return null;
  // A compacted/restored thread may only retain a later snapshot and no create
  // boundary. In that compatibility case, showing the snapshot is safer than
  // hiding Todo completely.
  if (batchIds.size === 0) return latest;
  return { ...latest, tasks: latest.tasks.filter((task) => batchIds.has(task.id)) };
}

/** Tasks a user-facing panel should show (tombstones are hidden). */
export function visibleTasks(snapshot: TodoSnapshot): TodoTask[] {
  return snapshot.tasks.filter((task) => task.status !== "deleted");
}

/** Derived presentation state for the todo widgets (sticky bar / FAB). */
export interface TodoViewModel {
  tasks: TodoTask[];
  total: number;
  completed: number;
  /** 0..100 rounded; 0 when there are no tasks. */
  percent: number;
  /** The task the agent is currently working on (first in_progress, else
   *  first pending), or null when every task is finished. UI shows
   *  `activeForm || subject` for it. */
  activeTask: TodoTask | null;
  /** One-based position of activeTask in the visible task list. */
  activeIndex: number | null;
  /** Number of visible tasks whose dependencies are still unfinished. */
  blockedCount: number;
  allCompleted: boolean;
}

/** Build the widget view model from thread blocks; null when the thread has
 *  no visible todo tasks. */
export function todoViewModel(blocks: ThreadBlock[]): TodoViewModel | null {
  const snapshot = extractLatestTodoBatchSnapshot(blocks);
  if (!snapshot) return null;
  const tasks = visibleTasks(snapshot);
  if (tasks.length === 0) return null;
  const completed = tasks.filter((task) => task.status === "completed").length;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const activeTask = tasks.find((task) => task.status === "in_progress")
    ?? tasks.find((task) => task.status === "pending")
    ?? null;
  return {
    tasks,
    total: tasks.length,
    completed,
    percent: Math.round((completed / tasks.length) * 100),
    activeTask,
    activeIndex: activeTask ? tasks.findIndex((task) => task.id === activeTask.id) + 1 : null,
    blockedCount: tasks.filter((task) => (task.blockedBy ?? []).some((id) => {
      const dependency = byId.get(id);
      return dependency !== undefined && dependency.status !== "completed";
    })).length,
    allCompleted: completed === tasks.length,
  };
}
