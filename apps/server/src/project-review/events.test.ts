import { describe, expect, it } from "vitest";
import { emitProjectKnowledgeEvent, subscribeProjectKnowledgeEvents } from "./events.js";

const workspace = "/tmp/pi-science-project-knowledge-events";

describe("project knowledge events", () => {
  it("delivers changes only to subscribers of the same workspace", () => {
    const received: number[] = [];
    const cleanup = subscribeProjectKnowledgeEvents(workspace, (event) => received.push(event.pending_count));
    const otherCleanup = subscribeProjectKnowledgeEvents(`${workspace}-other`, () => received.push(-1));

    emitProjectKnowledgeEvent(workspace, { type: "project-knowledge.changed", pending_count: 3 });

    expect(received).toEqual([3]);
    cleanup();
    otherCleanup();
  });

  it("removes a subscriber without affecting later subscribers", () => {
    const first: number[] = [];
    const second: number[] = [];
    const cleanup = subscribeProjectKnowledgeEvents(workspace, (event) => first.push(event.pending_count));
    emitProjectKnowledgeEvent(workspace, { type: "project-knowledge.changed", pending_count: 1 });
    cleanup();
    const cleanupSecond = subscribeProjectKnowledgeEvents(workspace, (event) => second.push(event.pending_count));
    emitProjectKnowledgeEvent(workspace, { type: "project-knowledge.changed", pending_count: 2 });

    expect(first).toEqual([1]);
    expect(second).toEqual([2]);
    cleanupSecond();
  });

  it("isolates listener failures", () => {
    const cleanup = subscribeProjectKnowledgeEvents(workspace, () => { throw new Error("subscriber failed"); });
    expect(() => emitProjectKnowledgeEvent(workspace, { type: "project-knowledge.changed", pending_count: 4 })).not.toThrow();
    cleanup();
  });
});
