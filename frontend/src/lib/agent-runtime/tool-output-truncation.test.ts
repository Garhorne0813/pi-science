import { describe, expect, it } from "vitest";

import { emptyThread, foldEvent } from "./event-fold";
import type { Thread } from "./event-fold";
import type { ToolCallBlock } from "../../types/thread";
import { installRuntimeTestEnvironment } from "./test-helpers";

installRuntimeTestEnvironment();

function lastTool(thread: Thread): ToolCallBlock {
  const block = thread.blocks.filter((candidate) => candidate.kind === "tool").at(-1);
  if (!block || block.kind !== "tool") throw new Error("no tool block");
  return block;
}

describe("tool output truncation flag", () => {
  it("keeps the flag from a truncated streaming tail", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, { sessionId: "s", type: "tool.started", callId: "c1", tool: "bash", status: "running" });
    thread = foldEvent(thread, {
      sessionId: "s",
      type: "tool.updated",
      callId: "c1",
      tool: "bash",
      status: "running",
      partialOutput: "tail only",
      outputTruncated: true,
      originalOutputBytes: 123_456,
    });
    expect(lastTool(thread)).toMatchObject({ outputTruncated: true, originalOutputBytes: 123_456 });
  });

  it("drops the flag when the completed output is complete", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, { sessionId: "s", type: "tool.started", callId: "c1", tool: "bash", status: "running" });
    thread = foldEvent(thread, {
      sessionId: "s",
      type: "tool.updated",
      callId: "c1",
      tool: "bash",
      status: "running",
      partialOutput: "tail only",
      outputTruncated: true,
      originalOutputBytes: 123_456,
    });
    thread = foldEvent(thread, { sessionId: "s", type: "tool.completed", callId: "c1", tool: "bash", status: "done", output: "full output" });
    const block = lastTool(thread);
    expect(block.outputTruncated).toBeUndefined();
    expect(block.originalOutputBytes).toBeUndefined();
  });

  it("keeps the flag when the completed output is truncated, and tolerates old events without it", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, { sessionId: "s", type: "tool.started", callId: "c1", tool: "bash", status: "running" });
    thread = foldEvent(thread, { sessionId: "s", type: "tool.completed", callId: "c1", tool: "bash", status: "done", output: "old event without the field" });
    expect(lastTool(thread).outputTruncated).toBeUndefined();
    thread = foldEvent(thread, {
      sessionId: "s",
      type: "tool.completed",
      callId: "c1",
      tool: "bash",
      status: "done",
      output: "tail only",
      outputTruncated: true,
      originalOutputBytes: 70_000,
    });
    expect(lastTool(thread)).toMatchObject({ outputTruncated: true, originalOutputBytes: 70_000 });
  });
});
