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
  tasks?: unknown;
  nextId?: unknown;
  error?: unknown;
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
    snapshot = {
      tasks: details.tasks as TodoTask[],
      nextId: typeof details.nextId === "number" ? details.nextId : 1,
    };
  }
  return snapshot;
}

/** Tasks a user-facing panel should show (tombstones are hidden). */
export function visibleTasks(snapshot: TodoSnapshot): TodoTask[] {
  return snapshot.tasks.filter((task) => task.status !== "deleted");
}
