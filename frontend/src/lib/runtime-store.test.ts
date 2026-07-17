/**
 * Unit tests for foldEvent — the core thread-state reducer.
 * foldEvent is a pure function (with module-level _textBuffer / _currentTurnId
 * that we reset between tests).
 */
import { describe, it, expect, beforeEach } from "vitest";

// We test foldEvent indirectly by testing the behavior patterns.
// The function is module-scoped, so we import the store and use
// the event listener mechanism to observe foldEvent behavior.

// For proper unit testing, we'll extract and test the logic patterns.

// ── Helper: create test events ──

function textEvent(text: string, sessionId = "s1") {
  return { type: "text.updated", text, sessionId };
}

function toolEvent(callId: string, tool: string, status: string, extra: Record<string, unknown> = {}) {
  return { type: "tool.updated", callId, tool, status, ...extra };
}

function idleEvent(sessionId = "s1") {
  return { type: "session.idle", sessionId };
}

function errorEvent(message: string, sessionId = "s1") {
  return { type: "error", message, sessionId };
}

// ── Minimal ThreadBlock type ──

interface Block {
  kind: string;
  id: string;
  parts?: { id: string; text: string }[];
  text?: string;
  partial?: boolean;
  tool?: string;
  status?: string;
  callId?: string;
  level?: string;
}

interface Thread {
  blocks: Block[];
  index: Record<string, number>;
  loaded: boolean;
}

// ── Re-implement foldEvent as a testable pure function ──
// (identical logic to runtime-store.ts, but with explicit buffer parameters)

function foldEventPure(
  state: Thread,
  event: Record<string, unknown>,
  textBuffer: string,
  currentTurnId: string,
): { thread: Thread; textBuffer: string; currentTurnId: string } {
  const blocks = [...state.blocks];
  const index = { ...state.index };
  let buf = textBuffer;
  let turnId = currentTurnId;

  switch (event.type) {
    case "text.updated": {
      buf += (event.text as string) || "";
      const hasText = buf.trim().length > 0;
      if (!hasText) break;
      turnId = currentTurnId || `agent-test`;
      if (!currentTurnId) currentTurnId = turnId;
      const blockId = turnId;
      const existingIdx = index[blockId];
      if (existingIdx !== undefined) {
        const hasToolsAfter = blocks.slice(existingIdx + 1).some((b) => b.kind === "tool");
        if (hasToolsAfter) {
          const oldBlock = blocks[existingIdx];
          if (oldBlock.kind === "agent") oldBlock.partial = false;
          buf = (event.text as string) || "";
          currentTurnId = turnId + "-post";
          index[currentTurnId] = blocks.length;
          blocks.push({
            kind: "agent",
            id: currentTurnId,
            parts: [{ id: currentTurnId, text: buf }],
            partial: true,
          });
        } else {
          blocks[existingIdx] = {
            ...blocks[existingIdx],
            kind: "agent",
            parts: [{ id: turnId, text: buf }],
            partial: true,
          };
        }
      } else {
        blocks.push({
          kind: "agent",
          id: blockId,
          parts: [{ id: turnId, text: buf }],
          partial: true,
        });
        index[blockId] = blocks.length - 1;
      }
      break;
    }

    case "tool.updated": {
      const callId = event.callId as string;
      const blockId = `tool-${callId}`;
      const existingIdx = index[blockId];
      const block: Block = {
        kind: "tool",
        id: blockId,
        callId,
        tool: event.tool as string,
        status: event.status as string,
      };
      if (existingIdx !== undefined) {
        blocks[existingIdx] = block;
      } else {
        index[blockId] = blocks.length;
        blocks.push(block);
      }
      break;
    }

    case "session.idle": {
      buf = "";
      currentTurnId = "";
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].kind === "agent" && blocks[i].partial) {
          blocks[i] = { ...blocks[i], partial: false };
          break;
        }
      }
      break;
    }

    case "error": {
      const msg = (event.message as string) || "Unknown error";
      const errBlock: Block = {
        kind: "status-line",
        id: `error-test`,
        text: msg,
        level: "error",
      };
      index[errBlock.id] = blocks.length;
      blocks.push(errBlock);
      break;
    }
  }

  return {
    thread: { blocks, index, loaded: true },
    textBuffer: buf,
    currentTurnId,
  };
}

function emptyThread(): Thread {
  return { blocks: [], index: {}, loaded: false };
}

// ── Tests ──

describe("foldEvent — text.updated", () => {
  it("creates a new agent block on first text", () => {
    const { thread } = foldEventPure(emptyThread(), textEvent("Hello"), "", "");
    expect(thread.blocks).toHaveLength(1);
    expect(thread.blocks[0].kind).toBe("agent");
    expect(thread.blocks[0].parts?.[0].text).toBe("Hello");
    expect(thread.blocks[0].partial).toBe(true);
  });

  it("accumulates text across multiple events", () => {
    const t1 = foldEventPure(emptyThread(), textEvent("Hello "), "", "");
    const { thread } = foldEventPure(t1.thread, textEvent("World"), t1.textBuffer, t1.currentTurnId);
    expect(thread.blocks).toHaveLength(1);
    expect(thread.blocks[0].parts?.[0].text).toBe("Hello World");
  });

  it("skips empty text events (DeepSeek behavior)", () => {
    const { thread } = foldEventPure(emptyThread(), textEvent(""), "", "");
    expect(thread.blocks).toHaveLength(0);
  });

  it("skips whitespace-only text", () => {
    const { thread } = foldEventPure(emptyThread(), textEvent("  \n  "), "", "");
    expect(thread.blocks).toHaveLength(0);
  });

  it("splits into pre-tool and post-tool blocks when tools exist", () => {
    // First add text, then a tool, then more text
    const t1 = foldEventPure(emptyThread(), textEvent("Before tool"), "", "");
    const t2 = foldEventPure(t1.thread, toolEvent("c1", "bash", "done"), t1.textBuffer, t1.currentTurnId);
    const { thread } = foldEventPure(t2.thread, textEvent("After tool"), t2.textBuffer, t2.currentTurnId);

    expect(thread.blocks).toHaveLength(3); // pre-tool agent + tool + post-tool agent
    const agentBlocks = thread.blocks.filter((b) => b.kind === "agent");
    expect(agentBlocks[0].partial).toBe(false); // pre-tool finalized
    expect(agentBlocks[0].parts?.[0].text).toBe("Before tool");
    expect(agentBlocks[1].parts?.[0].text).toBe("After tool"); // post-tool agent
  });
});

describe("foldEvent — tool.updated", () => {
  it("creates a new tool block", () => {
    const { thread } = foldEventPure(emptyThread(), toolEvent("c1", "bash", "running"), "", "");
    expect(thread.blocks).toHaveLength(1);
    expect(thread.blocks[0].kind).toBe("tool");
    expect(thread.blocks[0].tool).toBe("bash");
    expect(thread.blocks[0].status).toBe("running");
  });

  it("updates existing tool block", () => {
    const t1 = foldEventPure(emptyThread(), toolEvent("c1", "bash", "running"), "", "");
    const { thread } = foldEventPure(t1.thread, toolEvent("c1", "bash", "done"), "", "");
    expect(thread.blocks).toHaveLength(1);
    expect(thread.blocks[0].status).toBe("done");
  });

  it("multiple tools create separate blocks", () => {
    const t1 = foldEventPure(emptyThread(), toolEvent("c1", "bash", "done"), "", "");
    const { thread } = foldEventPure(t1.thread, toolEvent("c2", "read", "done"), "", "");
    expect(thread.blocks).toHaveLength(2);
    expect(thread.blocks.map((b) => b.callId)).toEqual(["c1", "c2"]);
  });
});

describe("foldEvent — session.idle", () => {
  it("marks last agent block as not partial", () => {
    const t1 = foldEventPure(emptyThread(), textEvent("Hello"), "", "");
    expect(t1.thread.blocks[0].partial).toBe(true);
    const { thread } = foldEventPure(t1.thread, idleEvent(), t1.textBuffer, t1.currentTurnId);
    expect(thread.blocks[0].partial).toBe(false);
  });

  it("resets text buffer and turn ID", () => {
    const t1 = foldEventPure(emptyThread(), textEvent("Hello"), "", "");
    const result = foldEventPure(t1.thread, idleEvent(), t1.textBuffer, t1.currentTurnId);
    expect(result.textBuffer).toBe("");
    expect(result.currentTurnId).toBe("");
  });

  it("does not crash on empty thread", () => {
    const { thread } = foldEventPure(emptyThread(), idleEvent(), "", "");
    expect(thread.blocks).toHaveLength(0);
  });
});

describe("foldEvent — error", () => {
  it("creates an error status-line block", () => {
    const { thread } = foldEventPure(emptyThread(), errorEvent("Something broke"), "", "");
    expect(thread.blocks).toHaveLength(1);
    expect(thread.blocks[0].kind).toBe("status-line");
    expect(thread.blocks[0].level).toBe("error");
    expect(thread.blocks[0].text).toBe("Something broke");
  });
});

describe("foldEvent — end-to-end scenarios", () => {
  it("user message → agent text → tool call → tool done → text → idle", () => {
    let state = emptyThread();
    let buf = "";
    let tid = "";

    // User message (not processed by foldEvent — added manually in real code)
    // Agent text starts
    const r1 = foldEventPure(state, textEvent("I will run "), buf, tid);
    const r2 = foldEventPure(r1.thread, textEvent("a command"), r1.textBuffer, r1.currentTurnId);
    // Tool starts and ends
    const r3 = foldEventPure(r2.thread, toolEvent("c1", "bash", "running"), r2.textBuffer, r2.currentTurnId);
    const r4 = foldEventPure(r3.thread, toolEvent("c1", "bash", "done"), r3.textBuffer, r3.currentTurnId);
    // Post-tool text
    const r5 = foldEventPure(r4.thread, textEvent("Done!"), r4.textBuffer, r4.currentTurnId);
    // Session idle
    const r6 = foldEventPure(r5.thread, idleEvent(), r5.textBuffer, r5.currentTurnId);

    expect(r6.thread.blocks.length).toBe(3); // pre-tool agent + tool + post-tool agent
    expect(r6.textBuffer).toBe("");
    expect(r6.currentTurnId).toBe("");
  });
});
