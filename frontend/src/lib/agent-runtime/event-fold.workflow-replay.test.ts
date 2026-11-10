/** Full-segment replay of a body-plus-todo turn.
 *
 *  The visible projection of a turn is its joined answer text, its tool calls
 *  and the plan snapshot. Folding the identical wire segment a second time must
 *  leave that projection unchanged, and a later run may reuse the same item and
 *  call ids without losing its own body or plan. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emptyThread, foldEvent, type Thread } from "./event-fold";
import { extractTodoSnapshot } from "../conversation/todos";
import type { PiScienceEvent } from "../client/types";
import type { AgentMessageBlock, ToolCallBlock } from "../../types/thread";
import { installRuntimeTestEnvironment } from "./test-helpers";

installRuntimeTestEnvironment();

const CLOCK = new Date("2026-09-08T00:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(CLOCK);
});

afterEach(() => {
  vi.useRealTimers();
});

const FIRST_REPLY = "先查资料，再给结论。";
const SECOND_REPLY = "第二轮的计划另起一行。";
const FIRST_PLAN = [
  { id: 1, subject: "收集事件样本", status: "completed" },
  { id: 2, subject: "写出重放断言", status: "in_progress" },
];
const SECOND_PLAN = [{ id: 1, subject: "把结论写进计划", status: "pending" }];

const envelope = (overrides: Record<string, unknown>): PiScienceEvent => ({
  schemaVersion: 3,
  workspaceId: "/workspace",
  sessionId: "session-replay",
  streamEpoch: "epoch-1",
  eventId: `epoch-1:${String(overrides.seq)}`,
  seq: 0,
  turnId: "turn-1",
  runId: "run-1",
  occurredAt: "2026-09-08T00:00:00.000Z",
  type: "operation.started",
  payload: {},
  ...overrides,
});

function agentBodies(thread: Thread): string[] {
  return thread.blocks
    .filter((block): block is AgentMessageBlock => block.kind === "agent")
    .map((block) => block.parts.map((part) => part.text).join(""));
}

function toolCalls(thread: Thread): ToolCallBlock[] {
  return thread.blocks.filter((block): block is ToolCallBlock => block.kind === "tool");
}

function projection(thread: Thread) {
  return {
    bodies: agentBodies(thread),
    calls: toolCalls(thread).map((block) => block.callId),
    plan: extractTodoSnapshot(thread.blocks),
  };
}

const REPLAY_SCRIPT: PiScienceEvent[] = [
  envelope({ seq: 1, type: "operation.started" }),
  envelope({ seq: 2, itemId: "answer-plan", type: "message.delta", payload: { partId: "answer-plan:0", baseRevision: 0, revision: 1, text: "先查资料，" } }),
  envelope({ seq: 3, itemId: "answer-plan", type: "message.delta", payload: { partId: "answer-plan:0", baseRevision: 1, revision: 2, text: "再给结论。" } }),
  envelope({ seq: 4, itemId: "call-plan", type: "tool.started", callId: "call-plan", tool: "todo", status: "running" }),
  envelope({ seq: 5, itemId: "call-plan", type: "tool.completed", callId: "call-plan", tool: "todo", status: "done", details: { action: "create", tasks: FIRST_PLAN, nextId: 3 } }),
  envelope({ seq: 6, itemId: "answer-plan", type: "message.completed", payload: { revision: 2 } }),
  envelope({ seq: 7, type: "operation.settled", status: "completed" }),
];

const SECOND_RUN_SCRIPT: PiScienceEvent[] = [
  envelope({ seq: 8, runId: "run-2", turnId: "turn-2", type: "operation.started" }),
  envelope({ seq: 9, runId: "run-2", turnId: "turn-2", itemId: "answer-plan", type: "message.delta", payload: { partId: "answer-plan:0", baseRevision: 0, revision: 1, text: SECOND_REPLY } }),
  envelope({ seq: 10, runId: "run-2", turnId: "turn-2", itemId: "call-plan", type: "tool.started", callId: "call-plan", tool: "todo", status: "running" }),
  envelope({ seq: 11, runId: "run-2", turnId: "turn-2", itemId: "call-plan", type: "tool.completed", callId: "call-plan", tool: "todo", status: "done", details: { action: "create", tasks: SECOND_PLAN, nextId: 2 } }),
  envelope({ seq: 12, runId: "run-2", turnId: "turn-2", itemId: "answer-plan", type: "message.completed", payload: { revision: 1 } }),
  envelope({ seq: 13, runId: "run-2", turnId: "turn-2", type: "operation.settled", status: "completed" }),
];

describe("body plus todo segment replay", () => {
  it("leaves the visible projection unchanged when the segment is folded twice", () => {
    const once = REPLAY_SCRIPT.reduce(foldEvent, emptyThread());
    const replayed = REPLAY_SCRIPT.reduce(foldEvent, once);

    expect(agentBodies(replayed)).toEqual([FIRST_REPLY]);
    expect(toolCalls(replayed).map((block) => block.callId)).toEqual(["call-plan"]);
    expect(extractTodoSnapshot(replayed.blocks)).toEqual({ tasks: FIRST_PLAN, nextId: 3 });
    expect(projection(replayed)).toEqual(projection(once));
  });

  it("keeps the next run's body and plan when it reuses the same item and call ids", () => {
    const thread = [...REPLAY_SCRIPT, ...SECOND_RUN_SCRIPT].reduce(foldEvent, emptyThread());

    expect(agentBodies(thread)).toEqual([FIRST_REPLY, SECOND_REPLY]);
    expect(extractTodoSnapshot(thread.blocks)).toEqual({ tasks: SECOND_PLAN, nextId: 2 });

    const planCards = toolCalls(thread).filter((block) => block.callId === "call-plan");
    expect(planCards.at(-1)).toMatchObject({ runId: "run-2", turnId: "turn-2", status: "done" });
    // One reused callId still targets one tool block id, so this run's result
    // replaces the earlier card instead of adding a second card. Asserting one
    // card per run needs a change to tool block ids and is out of scope here.
  });
});
