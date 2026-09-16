import { describe, expect, it } from "vitest";

import { emptyThread, foldEvent, threadFromMessages } from "./event-fold";

const narration = "这是经过完整验证的最终回答正文。";

describe("narration subsumption safety", () => {
  it("never suppresses an explicit final that repeats intermediate narration", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, {
      sessionId: "s",
      type: "text.updated",
      turnId: "t1",
      partId: "m1",
      text: narration,
      revision: 1,
      presentationRole: "intermediate",
    });
    thread = foldEvent(thread, {
      sessionId: "s",
      type: "text.updated",
      turnId: "t1",
      partId: "m2",
      text: narration,
      revision: 1,
      presentationRole: "final",
    });

    const agents = thread.blocks.filter((block) => block.kind === "agent");
    expect(agents).toHaveLength(2);
    expect(agents.at(-1)).toMatchObject({ presentationRole: "final" });
    expect(thread.foldState?.textByKey.m2?.suppressed).not.toBe(true);
  });

  it("keeps the logical block id stable across suppressed revisions", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, {
      sessionId: "s",
      type: "text.updated",
      turnId: "t1",
      partId: "m1",
      text: narration,
      revision: 1,
      presentationRole: "intermediate",
    });
    thread = foldEvent(thread, {
      sessionId: "s",
      type: "text.updated",
      turnId: "t1",
      partId: "m2",
      text: narration,
      replace: true,
      revision: 1,
      presentationRole: "intermediate",
    });

    const first = thread.foldState?.textByKey.m2;
    expect(first).toMatchObject({ blockId: "agent-t1-m2", suppressed: true });
    expect(first?.blockId).not.toContain("subsumed-");

    thread = foldEvent(thread, {
      sessionId: "s",
      type: "text.updated",
      turnId: "t1",
      partId: "m2",
      text: narration,
      replace: true,
      revision: 2,
      presentationRole: "intermediate",
    });

    const second = thread.foldState?.textByKey.m2;
    expect(second).toMatchObject({ blockId: "agent-t1-m2", suppressed: true });
    expect(thread.blocks.filter((block) => block.kind === "agent")).toHaveLength(1);
  });

  it("keeps explicit-final semantics aligned after history rebuild", () => {
    const thread = threadFromMessages([
      { id: "u1", role: "user", content: [{ type: "text", text: "研究" }] },
      {
        id: "m1",
        role: "assistant",
        presentationRole: "intermediate",
        content: [{ type: "text", text: narration }],
      },
      {
        id: "m2",
        role: "assistant",
        presentationRole: "final",
        content: [{ type: "text", text: narration }],
      },
    ]);

    const agents = thread.blocks.filter((block) => block.kind === "agent");
    expect(agents).toHaveLength(2);
    expect(agents.at(-1)).toMatchObject({ id: "m2", presentationRole: "final" });
  });
});
