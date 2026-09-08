import { describe, expect, it, vi } from "vitest";

import { convertHistoryToBlocks, mergeHistoryWindow, replaceHistoryTail, useRuntimeStore } from "./index";
import { emptyThread, foldEvent, threadFromMessages, type Thread } from "./event-fold";
import type { HistoryMessage, PiScienceEvent } from "../client/types";
import type { ThreadBlock } from "../../types/thread";
import { FakeEventSource, installRuntimeTestEnvironment, jsonResponse, state } from "./test-helpers";


installRuntimeTestEnvironment();

describe("transport event folding", () => {

  it("preserves older user messages when a settled tail is refreshed", () => {
    const current = { blocks: convertHistoryToBlocks([
      { id: "user-old", role: "user", content: [{ type: "text", text: "old question" }] },
      { id: "tool-old", role: "toolResult", toolCallId: "call-old", toolName: "read", content: [{ type: "text", text: "old result" }] },
      { id: "tool-tail", role: "toolResult", toolCallId: "call-tail", toolName: "read", content: [{ type: "text", text: "tail result" }] },
    ]), index: {}, loaded: true };
    const next = replaceHistoryTail(current, [
      { id: "tool-tail", role: "toolResult", toolCallId: "call-tail", toolName: "read", content: [{ type: "text", text: "fresh tail result" }] },
    ]);
    expect(next.blocks.map((block) => block.id)).toEqual(["user-old", "tool-call-old", "tool-call-tail"]);
    expect(next.blocks.at(-1)).toMatchObject({ output: "fresh tail result" });
  });

  it("carries observed tool timing across a settle-time resync", () => {
    const current = threadFromMessages([
      { id: "user-1", role: "user", content: [{ type: "text", text: "run" }] },
    ]);
    current.blocks.push({
      kind: "tool", id: "tool-call-1", callId: "call-1", tool: "bash", status: "done",
      output: "ok", startedAt: "2026-09-08T00:00:00.000Z", endedAt: "2026-09-08T00:00:02.400Z",
    } as ThreadBlock);
    const merged = replaceHistoryTail(current, [
      { id: "user-1", role: "user", content: [{ type: "text", text: "run" }] },
      { id: "assistant-1", role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash" }] },
      { id: "result-1", role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "ok" }], timestamp: "2026-09-08T00:00:03.000Z" },
    ]);
    const tool = merged.blocks.find((block) => block.kind === "tool" && block.callId === "call-1") as { startedAt?: string; endedAt?: string };
    expect(tool.startedAt).toBe("2026-09-08T00:00:00.000Z");
    expect(tool.endedAt).toBe("2026-09-08T00:00:02.400Z");
  });

  it("merges durable user history with replayed live output during a mid-turn reload", async () => {
    let resolveMessages!: (response: Response) => void;
    let resolveState!: (response: Response) => void;
    const messages = new Promise<Response>((resolve) => { resolveMessages = resolve; });
    const runtimeState = new Promise<Response>((resolve) => { resolveState = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return messages;
      if (url.includes("/state")) return runtimeState;
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));

    const connecting = useRuntimeStore.getState().connect("/workspace", "session-a");
    await Promise.resolve();
    FakeEventSource.instances[0].emit("text.updated", {
      type: "text.updated",
      sessionId: "session-a",
      partId: "assistant-live",
      text: "live answer",
    });
    resolveMessages(jsonResponse({ messages: [{
      id: "user-persisted",
      role: "user",
      content: [{ type: "text", text: "persisted question" }],
    }] }));
    resolveState(jsonResponse(state("session-a", { is_streaming: true })));
    await connecting;

    const blocks = useRuntimeStore.getState().thread.blocks;
    expect(blocks).toContainEqual(
      expect.objectContaining({ kind: "user", text: "persisted question" }),
    );
    expect(blocks).toContainEqual(
      expect.objectContaining({ kind: "agent", id: "assistant-live" }),
    );
  });

  it("replaces accumulated text when the server sends a corrected final snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a", { is_streaming: true }));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    FakeEventSource.instances[0].emit("agent_start", { type: "agent_start", sessionId: "session-a" });
    FakeEventSource.instances[0].emit("text.updated", {
      type: "text.updated", sessionId: "session-a", partId: "assistant-live", text: "helo",
    });
    FakeEventSource.instances[0].emit("text.updated", {
      type: "text.updated", sessionId: "session-a", partId: "assistant-live", text: "hello", replace: true,
    });

    expect(useRuntimeStore.getState().thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "agent", parts: [{ id: "assistant-live", text: "hello" }] }),
    );
  });

  it("preserves a tool name when update/end events omit it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    source.emit("tool.updated", {
      type: "tool.updated",
      sessionId: "session-a",
      callId: "call-1",
      tool: "bash",
      status: "running",
      title: "Running conversation tests",
    });
    source.emit("tool.updated", {
      type: "tool.updated",
      sessionId: "session-a",
      callId: "call-1",
      tool: "",
      status: "done",
      details: { exitCode: 0 },
    });

    expect(useRuntimeStore.getState().thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "tool", callId: "call-1", tool: "bash", status: "done", title: "Running conversation tests", details: { exitCode: 0 } }),
    );
  });

  it("stamps arrival times so finished steps carry a duration", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    source.emit("tool.updated", { type: "tool.updated", sessionId: "session-a", callId: "call-1", tool: "bash", status: "running" });
    const running = useRuntimeStore.getState().thread.blocks.find((block) => block.kind === "tool" && block.callId === "call-1") as { startedAt?: string };
    expect(typeof running.startedAt).toBe("string");
    await new Promise((resolve) => setTimeout(resolve, 5));
    source.emit("tool.updated", { type: "tool.updated", sessionId: "session-a", callId: "call-1", tool: "bash", status: "done" });
    const done = useRuntimeStore.getState().thread.blocks.find((block) => block.kind === "tool" && block.callId === "call-1") as { startedAt?: string; endedAt?: string };
    expect(typeof done.endedAt).toBe("string");
    expect(Date.parse(done.endedAt!) - Date.parse(done.startedAt!)).toBeGreaterThanOrEqual(0);
  });

  it("keeps tool presentation metadata across live updates", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-a"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-a");
    const source = FakeEventSource.instances[0];
    const presentation = { version: 1 as const, kind: "verify" as const, title: "Run frontend tests", importance: "stage" as const, domain: "code" as const };
    source.emit("tool.updated", { type: "tool.updated", sessionId: "session-a", callId: "call-1", tool: "bash", status: "running", presentation });
    source.emit("tool.updated", { type: "tool.updated", sessionId: "session-a", callId: "call-1", tool: "bash", status: "done" });
    expect(useRuntimeStore.getState().thread.blocks).toContainEqual(expect.objectContaining({ presentation }));
    source.emit("text.updated", {
      type: "text.updated",
      sessionId: "session-a",
      partId: "assistant-final",
      text: "final",
      presentationRole: "final",
    });
    expect(useRuntimeStore.getState().thread.blocks).toContainEqual(expect.objectContaining({ kind: "agent", presentationRole: "final" }));

  });

  it("renders compaction start, completion, and failure state", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/messages")) return jsonResponse({ messages: [] });
      if (url.includes("/state")) return jsonResponse(state("session-1"));
      if (url.startsWith("/api/sessions?")) return jsonResponse([]);
      throw new Error(`Unexpected request: ${url}`);
    }));
    await useRuntimeStore.getState().connect("/workspace", "session-1");
    FakeEventSource.instances[0].emit("compaction.updated", { type: "compaction.updated", sessionId: "session-1", status: "start" });
    expect(useRuntimeStore.getState().thread.blocks).toContainEqual(
      expect.objectContaining({ id: "compaction-status", level: "info", text: expect.stringContaining("Compacting") }),
    );
    FakeEventSource.instances[0].emit("compaction.updated", { type: "compaction.updated", sessionId: "session-1", status: "end" });
    expect(useRuntimeStore.getState().thread.blocks).toContainEqual(
      expect.objectContaining({ id: "compaction-status", level: "done", text: "Conversation context compacted" }),
    );
    FakeEventSource.instances[0].emit("compaction.updated", { type: "compaction.updated", sessionId: "session-1", status: "error", message: "context overflow" });
    expect(useRuntimeStore.getState().thread.blocks).toContainEqual(
      expect.objectContaining({ id: "compaction-status", level: "error", text: expect.stringContaining("context overflow") }),
    );
  });
});


describe("history window merges", () => {
  const loadedPage = (ids: Array<[string, string]>): HistoryMessage[] => ids.map(([id, text]) => ({ id, role: "user", content: [{ type: "text", text }] }) as HistoryMessage);
  const blockIds = (thread: Thread) => thread.blocks.map((block) => block.id);

  it("keeps the older boundary when a tail refresh retains loaded pages", () => {
    // Loaded window u1..u10 describes the whole history (no older pages).
    // A later tail page only returns u9..u10; its cursor must not pull the
    // boundary back into the already-loaded pages.
    const current = threadFromMessages(loadedPage([["u1", "a"], ["u2", "b"], ["u9", "i"], ["u10", "j"]]));
    const merged = mergeHistoryWindow(current, loadedPage([["u9", "i-refreshed"], ["u10", "j-refreshed"]]), { keepLiveExtras: false });
    expect(merged.retainedOlderPrefix).toBe(true);
    expect(blockIds(merged.thread)).toEqual(["u1", "u2", "u9", "u10"]);
    expect(merged.thread.blocks[2]).toMatchObject({ text: "i-refreshed" });
  });

  it("re-derives the boundary when the snapshot shares no lineage", () => {
    const current = threadFromMessages(loadedPage([["u1", "old"]]));
    const merged = mergeHistoryWindow(current, loadedPage([["rewritten-1", "new"]]), { keepLiveExtras: false });
    expect(merged.retainedOlderPrefix).toBe(false);
    expect(blockIds(merged.thread)).toEqual(["rewritten-1"]);
  });

  it("keeps live extras behind the snapshot during mid-stream recovery", () => {
    const current = threadFromMessages(loadedPage([["u1", "older"], ["u2", "older2"]]));
    current.blocks.push({ kind: "agent", id: "assistant-live", parts: [{ id: "assistant-live", text: "streaming…" }], partial: true } as ThreadBlock);
    const merged = mergeHistoryWindow(current, loadedPage([["u2", "older2"], ["u3", "newer"]]), { keepLiveExtras: true });
    expect(merged.retainedOlderPrefix).toBe(true);
    expect(blockIds(merged.thread)).toEqual(["u1", "u2", "u3", "assistant-live"]);
  });

  it("lets a settled snapshot drop live extras covered by authoritative history", () => {
    const current = threadFromMessages(loadedPage([["u1", "older"]]));
    current.blocks.push({ kind: "agent", id: "assistant-live", parts: [{ id: "assistant-live", text: "partial…" }], partial: true } as ThreadBlock);
    const merged = mergeHistoryWindow(current, loadedPage([["u1", "older"], ["assistant-final", "done text"]]), { keepLiveExtras: false });
    expect(blockIds(merged.thread)).toEqual(["u1", "assistant-final"]);
  });
});

describe("conversation history conversion", () => {
  it("maps tool results by toolCallId instead of using the previous tool or unknown", () => {
    const blocks = convertHistoryToBlocks([
      {
        id: "assistant-1",
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-read", name: "read" },
          { type: "toolCall", id: "call-bash", name: "bash" },
        ],
      },
      {
        id: "result-bash",
        role: "toolResult",
        toolCallId: "call-bash",
        toolName: "bash",
        content: [{ type: "text", text: "done" }],
      },
      {
        id: "result-read",
        role: "toolResult",
        toolCallId: "call-read",
        toolName: "read",
        content: [{ type: "text", text: "content" }],
      },
    ]);

    expect(blocks).toEqual([
      expect.objectContaining({ kind: "tool", callId: "call-bash", tool: "bash" }),
      expect.objectContaining({ kind: "tool", callId: "call-read", tool: "read" }),
    ]);
  });

  it("restores tool and assistant presentation metadata from history", () => {
    const presentation = { version: 1 as const, kind: "verify" as const, title: "Run frontend tests", importance: "stage" as const, domain: "code" as const };
    const blocks = convertHistoryToBlocks([
      { id: "assistant-1", role: "assistant", presentationRole: "final", content: [{ type: "text", text: "answer" }, { type: "toolCall", id: "call-1", name: "bash", presentation }] },
      { id: "result-1", role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "done" }], presentation },
    ]);
    expect(blocks).toContainEqual(expect.objectContaining({ kind: "agent", presentationRole: "final" }));
    expect(blocks).toContainEqual(expect.objectContaining({ kind: "tool", presentation }));
  });
  it("carries toolResult details through so panels can rebuild tool state", () => {
    const blocks = convertHistoryToBlocks([
      {
        id: "result-todo",
        role: "toolResult",
        toolCallId: "call-todo",
        toolName: "todo",
        content: [{ type: "text", text: "Created #1: x (pending)" }],
        details: { action: "create", params: {}, nextId: 2, tasks: [{ id: 1, subject: "x", status: "pending" }] },
      },
    ]);
    expect(blocks[0]).toMatchObject({
      kind: "tool",
      tool: "todo",
      details: { action: "create", params: {}, nextId: 2, tasks: [{ id: 1, subject: "x", status: "pending" }] },
    });
  });
});

describe("conversation presentation protocol v2", () => {
  const envelope = (overrides: Record<string, unknown>): PiScienceEvent => ({
    schemaVersion: 2,
    workspaceId: "/workspace",
    sessionId: "session-v2",
    streamEpoch: "epoch-1",
    eventId: `epoch-1:${String(overrides.seq)}`,
    seq: 0,
    turnId: "turn-1",
    runId: "run-1",
    occurredAt: "2026-09-08T00:00:00.000Z",
    type: "run.started",
    payload: {},
    ...overrides,
  });

  it("keeps item completion separate from run completion and deduplicates replay", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started", payload: {} }));
    thread = foldEvent(thread, envelope({
      seq: 2,
      type: "item.text.delta",
      itemId: "answer-1",
      payload: { partId: "answer-1", phase: "final_answer", baseRevision: 0, revision: 1, text: "answer" },
    }));
    thread = foldEvent(thread, envelope({ seq: 3, type: "item.completed", itemId: "answer-1", payload: { revision: 1 } }));
    const beforeRunCompletion = thread.blocks.find((block) => block.kind === "agent");
    expect(beforeRunCompletion).toMatchObject({ itemId: "answer-1", partial: false, presentationRole: "final" });
    expect(thread.foldState?.terminalRunIds).not.toContain("run-1");

    const duplicate = foldEvent(thread, envelope({
      seq: 2,
      type: "item.text.delta",
      itemId: "answer-1",
      payload: { partId: "answer-1", phase: "final_answer", baseRevision: 0, revision: 1, text: "answer" },
    }));
    expect(duplicate.blocks).toEqual(thread.blocks);

    thread = foldEvent(thread, envelope({ seq: 4, type: "run.completed", payload: { outcome: "ok" } }));
    expect(thread.foldState?.terminalRunIds).toContain("run-1");
  });

  it("maps commentary and final answer to separate stable items", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started", payload: {} }));
    thread = foldEvent(thread, envelope({
      seq: 2, type: "item.text.delta", itemId: "commentary-1",
      payload: { partId: "commentary-1", phase: "commentary", baseRevision: 0, revision: 1, text: "Reading files" },
    }));
    thread = foldEvent(thread, envelope({
      seq: 3, type: "item.text.delta", itemId: "answer-1",
      payload: { partId: "answer-1", phase: "final_answer", baseRevision: 0, revision: 1, text: "The answer" },
    }));
    expect(thread.blocks.filter((block) => block.kind === "agent")).toEqual([
      expect.objectContaining({ itemId: "commentary-1", presentationRole: "intermediate" }),
      expect.objectContaining({ itemId: "answer-1", presentationRole: "final" }),
    ]);
  });

  it("holds a sequence gap and drains it after the missing event arrives", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started", payload: {} }));
    thread = foldEvent(thread, envelope({
      seq: 3, type: "item.text.delta", itemId: "answer-1",
      payload: { partId: "answer-1", phase: "final_answer", baseRevision: 0, revision: 1, text: "answer" },
    }));
    expect(thread.blocks.some((block) => block.kind === "agent")).toBe(false);
    expect(thread.foldState?.reconciliationRequired).toBe(true);
    thread = foldEvent(thread, envelope({ seq: 2, type: "item.started", itemId: "answer-1", payload: { itemType: "assistant" } }));
    expect(thread.blocks).toContainEqual(expect.objectContaining({ kind: "agent", itemId: "answer-1" }));
    expect(thread.foldState?.pendingEvents).toHaveLength(0);
  });

  it("does not let a late callback from another session mutate the thread", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started", payload: {} }));
    const foreign = envelope({ sessionId: "session-other", seq: 2, type: "item.text.delta", itemId: "foreign", payload: { partId: "foreign", phase: "final_answer", baseRevision: 0, revision: 1, text: "foreign" } });
    const next = foldEvent(thread, foreign);
    expect(next).toEqual(thread);
  });

  it("refuses to append a delta when its base revision is stale", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started", payload: {} }));
    thread = foldEvent(thread, envelope({ seq: 2, type: "item.text.delta", itemId: "answer-1", payload: { partId: "answer-1", phase: "final_answer", baseRevision: 0, revision: 1, text: "correct" } }));
    const next = foldEvent(thread, envelope({ seq: 3, type: "item.text.delta", itemId: "answer-1", payload: { partId: "answer-1", phase: "final_answer", baseRevision: 0, revision: 2, text: " stale" } }));
    expect(next.blocks).toContainEqual(expect.objectContaining({ itemId: "answer-1", parts: [{ id: "answer-1", text: "correct" }] }));
    expect(next.foldState?.reconciliationRequired).toBe(true);
  });

  it("keeps a failed run readable while consuming late events for later artifacts", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started", payload: {} }));
    thread = foldEvent(thread, envelope({
      seq: 2,
      type: "item.text.delta",
      itemId: "answer-1",
      payload: { partId: "answer-1", phase: "final_answer", baseRevision: 0, revision: 1, text: "partial" },
    }));
    thread = foldEvent(thread, envelope({ seq: 3, type: "run.failed", payload: { message: "stream failed" } }));
    thread = foldEvent(thread, envelope({
      seq: 4,
      type: "item.text.delta",
      itemId: "answer-1",
      payload: { partId: "answer-1", phase: "final_answer", baseRevision: 1, revision: 2, text: " late" },
    }));
    thread = foldEvent(thread, envelope({
      seq: 5,
      type: "artifact.updated",
      payload: { artifacts: [{ path: "result.csv", kind: "table", mime: "text/csv", size: 10 }] },
    }));

    expect(thread.blocks).toContainEqual(expect.objectContaining({ kind: "agent", parts: [{ id: "answer-1", text: "partial" }] }));
    expect(thread.blocks).not.toContainEqual(expect.objectContaining({ kind: "agent", parts: [{ id: "answer-1", text: "partial late" }] }));
    expect(thread.blocks).toContainEqual(expect.objectContaining({ kind: "status-line", level: "error" }));
    expect(thread.blocks).toContainEqual(expect.objectContaining({ kind: "artifact-summary", turnId: "turn-1" }));
    expect(thread.foldState?.lastSequence).toBe(5);
  });
});
