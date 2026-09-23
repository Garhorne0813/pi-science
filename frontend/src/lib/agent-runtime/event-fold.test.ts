import { describe, expect, it, vi } from "vitest";

import { convertHistoryToBlocks, mergeHistoryWindow, replaceHistoryTail, useRuntimeStore } from "./index";
import { emptyThread, foldEvent, mergeHistoryWithLive, prependHistoryMessages, threadFromMessages, type Thread } from "./event-fold";
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

  it("rebuilds tool timing from history timestamps, keeping observed timing only for gaps", () => {
    const current = threadFromMessages([
      { id: "user-1", role: "user", content: [{ type: "text", text: "run" }] },
    ]);
    current.blocks.push({
      kind: "tool", id: "tool-call-1", callId: "call-1", tool: "bash", status: "done",
      output: "ok", startedAt: "2026-09-08T00:00:00.000Z", endedAt: "2026-09-08T00:00:02.400Z",
    } as ThreadBlock);
    // The persisted assistant message has no timestamp (legacy record): the
    // observed start survives. The result timestamp is authoritative for the end.
    const merged = replaceHistoryTail(current, [
      { id: "user-1", role: "user", content: [{ type: "text", text: "run" }] },
      { id: "assistant-1", role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash" }] },
      { id: "result-1", role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "ok" }], timestamp: "2026-09-08T00:00:03.000Z" },
    ]);
    const tool = merged.blocks.find((block) => block.kind === "tool" && block.callId === "call-1") as { startedAt?: string; endedAt?: string };
    expect(tool.startedAt).toBe("2026-09-08T00:00:00.000Z");
    expect(tool.endedAt).toBe("2026-09-08T00:00:03.000Z");
  });

  it("derives full tool timing from history when the live tail was never observed", () => {
    const merged = threadFromMessages([
      { id: "user-1", role: "user", content: [{ type: "text", text: "run" }], timestamp: "2026-09-08T00:00:00.000Z" },
      { id: "assistant-1", role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash" }], timestamp: "2026-09-08T00:00:01.000Z" },
      { id: "result-1", role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "ok" }], timestamp: "2026-09-08T00:00:02.400Z" },
    ]);
    const tool = merged.blocks.find((block) => block.kind === "tool" && block.callId === "call-1") as { startedAt?: string; endedAt?: string };
    expect(tool.startedAt).toBe("2026-09-08T00:00:01.000Z");
    expect(tool.endedAt).toBe("2026-09-08T00:00:02.400Z");
  });

  it("restores tool inputs and keeps calls that have no result yet", () => {
    const thread = threadFromMessages([
      { id: "user-1", role: "user", content: [{ type: "text", text: "inspect" }] },
      { id: "assistant-1", role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }] },
    ]);
    expect(thread.blocks.find((block) => block.kind === "tool")).toMatchObject({
      kind: "tool", callId: "call-1", tool: "read", status: "running", input: { path: "a.ts" },
    });
  });

  it("preserves non-text tool result content as structured details", () => {
    const thread = threadFromMessages([
      { id: "assistant-1", role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "image", arguments: { prompt: "plot" } }] },
      { id: "result-1", role: "toolResult", toolCallId: "call-1", content: [{ type: "image", mimeType: "image/png", data: "abc" }] },
    ]);
    expect(thread.blocks.find((block) => block.kind === "tool")).toMatchObject({
      kind: "tool", callId: "call-1", status: "done", input: { prompt: "plot" },
      details: { content: [{ type: "image", mimeType: "image/png", data: "abc" }] },
    });
  });

  it("enriches a tool result when pagination splits it from its older call", () => {
    const current = threadFromMessages([
      { id: "result-1", role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "done" }], timestamp: "2026-09-08T00:00:02.000Z" },
    ]);
    const merged = prependHistoryMessages(current, [
      { id: "assistant-1", role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }], timestamp: "2026-09-08T00:00:01.000Z" },
    ]);
    expect(merged.blocks).toHaveLength(1);
    expect(merged.blocks[0]).toMatchObject({
      kind: "tool", callId: "call-1", tool: "read", status: "done", input: { path: "a.ts" },
      output: "done", startedAt: "2026-09-08T00:00:01.000Z", endedAt: "2026-09-08T00:00:02.000Z",
      statusHistory: ["running", "done"],
    });
  });

  it("collapses narration that a later message repeats verbatim", () => {
    let thread = emptyThread();
    const emitText = (partId: string, text: string) => {
      thread = foldEvent(thread, { sessionId: "s", type: "text.updated", turnId: "t1", partId, text, revision: 1 });
    };
    emitText("m1", "Todo 列表已创建。在开始之前，说说主题。");
    emitText("m2", "好的。Todo 列表已创建。在开始之前，说说主题。");
    const narration = thread.blocks.filter((block) => block.kind === "agent");
    expect(narration).toHaveLength(1);
    expect(narration[0]?.kind === "agent" && narration[0].parts[0]?.text).toContain("好的。");
    // A short subset is retained because substring overlap alone is not
    // enough evidence that a distinct process observation is duplicated.
    emitText("m3", "Todo 列表已创建。");
    expect(thread.blocks.filter((block) => block.kind === "agent")).toHaveLength(2);
    // Unrelated narration still gets its own block.
    emitText("m4", "开始检索文献。");
    expect(thread.blocks.filter((block) => block.kind === "agent")).toHaveLength(3);
  });

  it("keeps the union when a streamed answer is echoed by later text", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, { sessionId: "s", type: "text.updated", turnId: "t1", partId: "m1", text: "这是经过完整验证的最终回答正文。", revision: 1 });
    thread = foldEvent(thread, { sessionId: "s", type: "text.updated", turnId: "t1", partId: "m2", text: "这是经过完整验证的最终回答正文。附注。", revision: 1 });
    const agents = thread.blocks.filter((block) => block.kind === "agent");
    expect(agents).toHaveLength(1);
    expect(agents[0]?.kind === "agent" && agents[0].parts[0]?.text).toBe("这是经过完整验证的最终回答正文。附注。");
  });

  it("does not delete short narration merely because later prose contains it", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, { sessionId: "s", type: "text.updated", turnId: "t1", partId: "m1", text: "Done", revision: 1 });
    thread = foldEvent(thread, { sessionId: "s", type: "text.updated", turnId: "t1", partId: "m2", text: "Done with discovery; starting verification.", revision: 1 });
    expect(thread.blocks.filter((block) => block.kind === "agent")).toHaveLength(2);
  });

  it("rebuilds history with the narration repeat collapsed", () => {
    const thread = threadFromMessages([
      { id: "u1", role: "user", content: [{ type: "text", text: "研究" }], timestamp: "2026-09-09T00:00:00.000Z" },
      { id: "m1", role: "assistant", content: [{ type: "text", text: "Todo 列表已创建。说说主题。" }] },
      { id: "m2", role: "assistant", content: [{ type: "text", text: "好的。Todo 列表已创建。说说主题。" }] },
      { id: "m3", role: "assistant", presentationRole: "final", content: [{ type: "text", text: "结论。" }] },
    ]);
    const narration = thread.blocks.filter((block) => block.kind === "agent");
    expect(narration).toHaveLength(2);
    expect(narration[0]?.kind === "agent" && narration[0].parts[0]?.text).toContain("好的。");
    expect(narration[1]?.kind === "agent" && narration[1].parts[0]?.text).toBe("结论。");
  });

  it("does not deduplicate legacy assistant narration across a user turn boundary", () => {
    const blocks = convertHistoryToBlocks([
      { id: "u1", role: "user", content: [{ type: "text", text: "What is the result?" }] },
      { id: "a1", role: "assistant", content: [{ type: "text", text: "Result: 42" }] },
      { id: "u2", role: "user", content: [{ type: "text", text: "Can you verify it?" }] },
      { id: "a2", role: "assistant", content: [{ type: "text", text: "Verified. Result: 42" }] },
    ]);

    expect(blocks.filter((block) => block.kind === "agent").map((block) => block.id)).toEqual(["a1", "a2"]);
  });

  it("folds thinking deltas into a reasoning block ahead of the narration", () => {    let thread = emptyThread();
    const emit = (payload: Record<string, unknown>) => { thread = foldEvent(thread, { sessionId: "s", type: "agent_start", ...payload, turnId: "t1" }); };
    emit({});
    for (const delta of ["Check the ", "imports."]) {
      thread = foldEvent(thread, { sessionId: "s", type: "thinking.updated", turnId: "t1", partId: "m1", text: delta, revision: 1 });
    }
    const thinking = thread.blocks.find((block) => block.kind === "thinking");
    expect(thinking && "parts" in thinking && thinking.parts[0]?.text).toBe("Check the imports.");
    // Narration arriving after thinking must not disturb the reasoning block.
    thread = foldEvent(thread, { sessionId: "s", type: "text.updated", turnId: "t1", partId: "m1", text: "Answer", revision: 2 });
    thread = foldEvent(thread, { sessionId: "s", type: "thinking.updated", turnId: "t1", partId: "m1", text: " more.", revision: 3 });
    const stillOne = thread.blocks.filter((block) => block.kind === "thinking");
    expect(stillOne).toHaveLength(1);
    expect(stillOne[0]?.kind === "thinking" && stillOne[0].parts[0]?.text).toBe("Check the imports. more.");
  });

  it("stamps the reasoning phase clock and closes it when the model moves on", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, { sessionId: "s", type: "agent_start", turnId: "t1" });
    thread = foldEvent(thread, { sessionId: "s", type: "thinking.updated", turnId: "t1", partId: "m1", text: "Weigh it.", revision: 1 });
    const open = thread.blocks.find((block) => block.kind === "thinking");
    expect(open?.kind === "thinking" && open.partial).toBe(true);
    expect(open?.kind === "thinking" && typeof open.startedAt).toBe("string");
    expect(open?.kind === "thinking" && open.endedAt).toBeUndefined();

    // Narration supersedes the phase: it closes even though the run continues.
    thread = foldEvent(thread, { sessionId: "s", type: "text.updated", turnId: "t1", partId: "m1", text: "Answer", revision: 2 });
    const closed = thread.blocks.find((block) => block.kind === "thinking");
    expect(closed?.kind === "thinking" && closed.partial).toBe(false);
    expect(closed?.kind === "thinking" && typeof closed.endedAt).toBe("string");
  });

  it("closes a running reasoning phase on a tool call and on idle", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, { sessionId: "s", type: "agent_start", turnId: "t1", runId: "r1" });
    thread = foldEvent(thread, { sessionId: "s", type: "thinking.updated", turnId: "t1", runId: "r1", partId: "m1", text: "Weigh it.", revision: 1 });
    thread = foldEvent(thread, { sessionId: "s", type: "tool.updated", turnId: "t1", runId: "r1", callId: "c1", tool: "read", status: "running" });
    const afterTool = thread.blocks.find((block) => block.kind === "thinking");
    expect(afterTool?.kind === "thinking" && afterTool.partial).toBe(false);
    expect(afterTool?.kind === "thinking" && typeof afterTool.endedAt).toBe("string");

    // A phase that is still open when the run settles also gets an end stamp.
    let idle = emptyThread();
    idle = foldEvent(idle, { sessionId: "s", type: "agent_start", turnId: "t2", runId: "r2" });
    idle = foldEvent(idle, { sessionId: "s", type: "thinking.updated", turnId: "t2", runId: "r2", partId: "m2", text: "Still reasoning.", revision: 1 });
    idle = foldEvent(idle, { sessionId: "s", type: "session.idle", runId: "r2" });
    const settled = idle.blocks.find((block) => block.kind === "thinking");
    expect(settled?.kind === "thinking" && settled.partial).toBe(false);
    expect(settled?.kind === "thinking" && typeof settled.endedAt).toBe("string");
  });

  it("rebuilds thinking rows from persisted assistant thinking parts", () => {
    const thread = threadFromMessages([
      { id: "u1", role: "user", content: [{ type: "text", text: "q" }], timestamp: "2026-09-08T00:00:00.000Z" },
      { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "Weigh the options." }, { type: "text", text: "The answer." }], timestamp: "2026-09-08T00:00:01.000Z" },
    ]);
    const kinds = thread.blocks.map((block) => block.kind);
    expect(kinds).toEqual(["user", "thinking", "agent"]);
    const thinking = thread.blocks[1];
    const narration = thread.blocks[2];
    expect(thinking.kind === "thinking" && thinking.parts[0]?.text).toBe("Weigh the options.");
    expect(narration.kind === "agent" && narration.parts[0]?.text).toBe("The answer.");
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
  it("maps tool results by toolCallId while preserving invocation order", () => {
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
      expect.objectContaining({ kind: "tool", callId: "call-read", tool: "read" }),
      expect.objectContaining({ kind: "tool", callId: "call-bash", tool: "bash" }),
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
    expect(beforeRunCompletion).toMatchObject({ itemId: "answer-1", revision: 1, sequence: 3, partial: false, presentationRole: "final" });
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

  it("folds V2 thinking deltas with flat wire fields into reasoning blocks", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started", payload: {} }));
    thread = foldEvent(thread, envelope({
      seq: 2,
      type: "thinking.updated",
      partId: "anonymous-1",
      text: "Weigh it.",
      baseRevision: 0,
      revision: 1,
      payload: {},
    }));
    const thinking = thread.blocks.find((block) => block.kind === "thinking");
    expect(thinking).toMatchObject({ itemId: "anonymous-1", revision: 1, sequence: 2 });
    expect(thinking && "parts" in thinking && thinking.parts[0]?.text).toBe("Weigh it.");
  });

  it("carries V2 identity and revision metadata onto tool blocks", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started", payload: {} }));
    thread = foldEvent(thread, envelope({
      seq: 2,
      type: "tool.updated",
      itemId: "tool-item-1",
      parentItemId: "parent-1",
      payload: { callId: "call-1", tool: "python", status: "running", revision: 4 },
    }));
    expect(thread.blocks.find((block) => block.kind === "tool")).toMatchObject({
      itemId: "tool-item-1",
      parentItemId: "parent-1",
      revision: 4,
      sequence: 2,
    });
  });

  it("reorders speculative V2 thinking revisions when a missing predecessor arrives", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started", payload: {} }));
    thread = foldEvent(thread, envelope({
      seq: 3, type: "thinking.updated", itemId: "reasoning-1",
      payload: { partId: "reasoning-1:0", baseRevision: 1, revision: 2, text: "B" },
    }));
    thread = foldEvent(thread, envelope({
      seq: 2, type: "thinking.updated", itemId: "reasoning-1",
      payload: { partId: "reasoning-1:0", baseRevision: 0, revision: 1, text: "A" },
    }));
    const thinking = thread.blocks.find((block) => block.kind === "thinking");
    expect(thinking && thinking.kind === "thinking" && thinking.parts[0]?.text).toBe("AB");
  });

  it("settles a reasoning block when its item completes", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started", payload: {} }));
    thread = foldEvent(thread, envelope({
      seq: 2, type: "thinking.updated", itemId: "reasoning-1",
      payload: { partId: "reasoning-1:0", baseRevision: 0, revision: 1, text: "A" },
    }));
    thread = foldEvent(thread, envelope({ seq: 3, type: "item.completed", itemId: "reasoning-1", payload: { revision: 1 } }));
    expect(thread.blocks.find((block) => block.kind === "thinking")).toMatchObject({ partial: false });
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
    expect(thread.blocks).toContainEqual(expect.objectContaining({ kind: "agent", itemId: "answer-1", parts: [{ id: "answer-1", text: "answer" }] }));
    expect(thread.foldState?.reconciliationRequired).toBe(true);
    expect(thread.foldState?.lastSequence).toBe(1);
    expect(thread.foldState?.pendingEvents).toHaveLength(1);
    expect(thread.foldState?.speculativeEventIds).toEqual(["epoch-1:3"]);
    thread = foldEvent(thread, envelope({ seq: 2, type: "item.started", itemId: "answer-1", payload: { itemType: "assistant" } }));
    expect(thread.blocks).toContainEqual(expect.objectContaining({ kind: "agent", itemId: "answer-1" }));
    expect(thread.blocks).toContainEqual(expect.objectContaining({ kind: "agent", parts: [{ id: "answer-1", text: "answer" }] }));
    expect(thread.foldState?.pendingEvents).toHaveLength(0);
    expect(thread.foldState?.speculativeEventIds).toHaveLength(0);
    expect(thread.foldState?.lastSequence).toBe(3);
  });

  it("keeps projecting text when a sequence gap never fills", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started", payload: {} }));
    thread = foldEvent(thread, envelope({
      seq: 3,
      type: "text.updated",
      itemId: "commentary-1",
      payload: {
        partId: "commentary-1", phase: "commentary", baseRevision: 0, revision: 1, text: "Reading files",
      },
    }));
    thread = foldEvent(thread, envelope({
      seq: 5,
      type: "text.updated",
      itemId: "commentary-1",
      payload: {
        partId: "commentary-1", phase: "commentary", baseRevision: 1, revision: 2, text: " …done",
      },
    }));

    expect(thread.blocks).toContainEqual(expect.objectContaining({
      kind: "agent",
      itemId: "commentary-1",
      parts: [{ id: "commentary-1", text: "Reading files …done" }],
    }));
    expect(thread.foldState?.pendingEvents.map((event) => event.seq)).toEqual([3, 5]);
    expect(thread.foldState?.lastSequence).toBe(1);
  });

  it("treats an epoch change as a recovery boundary instead of dropping the event silently", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started", payload: {} }));
    thread = foldEvent(thread, envelope({
      seq: 2,
      type: "text.updated",
      itemId: "old-item",
      payload: { partId: "old-item", phase: "final_answer", baseRevision: 0, revision: 1, text: "old projection" },
    }));

    const changedEpoch = foldEvent(thread, envelope({
      streamEpoch: "epoch-2",
      eventId: "epoch-2:1",
      seq: 1,
      type: "run.started",
      turnId: "turn-2",
      runId: "run-2",
      payload: {},
    }));

    expect(changedEpoch.blocks).toEqual(thread.blocks);
    expect(changedEpoch.foldState?.reconciliationRequired).toBe(true);
    expect(changedEpoch.foldState?.recoveryEpoch).toBe("epoch-2");
    expect(changedEpoch.foldState?.pendingEvents.map((event) => event.eventId)).toEqual(["epoch-2:1"]);
    expect(changedEpoch.foldState?.seenEventIds).toEqual([]);
    expect(changedEpoch.foldState?.textByKey).toEqual({});
    expect(changedEpoch.foldState?.terminalRunIds).toEqual([]);
  });

  it("reassembles replacement text split into ordered wire chunks", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started", payload: {} }));
    thread = foldEvent(thread, envelope({
      seq: 2,
      type: "text.updated",
      itemId: "answer-1",
      payload: {
        partId: "answer-1", phase: "final_answer", baseRevision: 0, revision: 1,
        replace: true, chunkIndex: 0, chunkCount: 2, text: "前半",
      },
    }));
    thread = foldEvent(thread, envelope({
      seq: 3,
      type: "text.updated",
      itemId: "answer-1",
      payload: {
        partId: "answer-1", phase: "final_answer", baseRevision: 0, revision: 1,
        chunkIndex: 1, chunkCount: 2, text: "后半",
      },
    }));

    expect(thread.blocks).toContainEqual(expect.objectContaining({
      kind: "agent",
      parts: [{ id: "answer-1", text: "前半后半" }],
    }));
    expect(thread.foldState?.reconciliationRequired).toBe(false);
    expect(thread.foldState?.lastSequence).toBe(3);
  });

  it("clears fold projection state when an authoritative history window is rebased", () => {
    let current = emptyThread();
    current = foldEvent(current, envelope({ seq: 1, type: "run.started", payload: {} }));
    current = foldEvent(current, envelope({
      seq: 2,
      type: "text.updated",
      itemId: "answer-1",
      payload: { partId: "answer-1", phase: "final_answer", baseRevision: 0, revision: 1, text: "speculative" },
    }));
    const merged = mergeHistoryWindow(current, [
      { id: "user-1", role: "user", content: [{ type: "text", text: "question" }] },
      { id: "answer-1", role: "assistant", content: [{ type: "text", text: "authoritative" }] },
    ], { keepLiveExtras: false, resetProjection: true });

    expect(merged.thread.blocks).toContainEqual(expect.objectContaining({ kind: "agent", parts: [{ id: "answer-1", text: "authoritative" }] }));
    expect(merged.thread.foldState).toBeUndefined();
  });

  it("reorders speculative text without replaying it as a burst", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started", payload: {} }));
    thread = foldEvent(thread, envelope({
      seq: 3,
      type: "item.text.delta",
      itemId: "answer-1",
      payload: { partId: "answer-1", phase: "final_answer", baseRevision: 1, revision: 2, text: " world" },
    }));
    expect(thread.blocks).toContainEqual(expect.objectContaining({
      kind: "agent",
      itemId: "answer-1",
      parts: [{ id: "answer-1", text: " world" }],
    }));

    thread = foldEvent(thread, envelope({
      seq: 2,
      type: "item.text.delta",
      itemId: "answer-1",
      payload: { partId: "answer-1", phase: "final_answer", baseRevision: 0, revision: 1, text: "hello" },
    }));

    expect(thread.blocks.filter((block) => block.kind === "agent")).toEqual([
      expect.objectContaining({ itemId: "answer-1", parts: [{ id: "answer-1", text: "hello world" }] }),
    ]);
    expect(thread.foldState?.pendingEvents).toHaveLength(0);
    expect(thread.foldState?.speculativeEventIds).toHaveLength(0);
    expect(thread.foldState?.lastSequence).toBe(3);
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

  it("tracks revisions per part while projecting multiple parts into one item", () => {
    let thread = emptyThread();
    thread = foldEvent(thread, envelope({ seq: 1, type: "run.started", payload: {} }));
    thread = foldEvent(thread, envelope({
      seq: 2,
      type: "item.text.delta",
      itemId: "answer-1",
      payload: { partId: "answer-1:0", phase: "final_answer", baseRevision: 0, revision: 1, text: "first" },
    }));
    thread = foldEvent(thread, envelope({
      seq: 3,
      type: "item.text.delta",
      itemId: "answer-1",
      payload: { partId: "answer-1:2", phase: "final_answer", baseRevision: 0, revision: 1, text: "second" },
    }));

    expect(thread.blocks.filter((block) => block.kind === "agent")).toEqual([
      expect.objectContaining({
        itemId: "answer-1",
        parts: [
          { id: "answer-1:0", text: "first" },
          { id: "answer-1:2", text: "second" },
        ],
      }),
    ]);
    expect(thread.foldState?.textByKey["answer-1:0"]?.revision).toBe(1);
    expect(thread.foldState?.textByKey["answer-1:2"]?.revision).toBe(1);
    expect(thread.foldState?.reconciliationRequired).toBe(false);
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

describe("mergeHistoryWithLive", () => {
  const optimisticUser = (id: string, text: string, timestamp: string): ThreadBlock =>
    ({ kind: "user", id, text, timestamp }) as ThreadBlock;
  const threadOf = (blocks: ThreadBlock[]): Thread => {
    const index: Record<string, number> = {};
    blocks.forEach((block, position) => { index[block.id] = position; });
    return { blocks, index, loaded: true };
  };

  it("drops an optimistic prompt once the durable copy of that send arrives", () => {
    const history = threadOf(convertHistoryToBlocks([
      { id: "58316547", role: "user", content: [{ type: "text", text: "run the notebook" }], timestamp: "2026-09-23T00:44:20.000Z" },
    ]));
    const live = threadOf([optimisticUser("user-1790095463523", "run the notebook", "2026-09-23T00:44:19.500Z")]);
    expect(mergeHistoryWithLive(history, live).blocks.map((block) => block.id)).toEqual(["58316547"]);
  });

  it("keeps a repeated prompt whose durable copy history has not recorded yet", () => {
    const history = threadOf(convertHistoryToBlocks([
      { id: "111", role: "user", content: [{ type: "text", text: "status" }], timestamp: "2026-09-23T00:10:00.000Z" },
    ]));
    const live = threadOf([optimisticUser("user-1790099999999", "status", "2026-09-23T00:44:00.000Z")]);
    expect(mergeHistoryWithLive(history, live).blocks.map((block) => block.id))
      .toEqual(["111", "user-1790099999999"]);
  });

  it("keeps an optimistic prompt when history has not caught up at all", () => {
    const live = threadOf([optimisticUser("user-1790099999999", "brand new", "2026-09-23T00:44:00.000Z")]);
    expect(mergeHistoryWithLive(threadOf([]), live).blocks.map((block) => block.id))
      .toEqual(["user-1790099999999"]);
  });

  it("matches a persisted prompt after a shared history block even when the browser clock runs ahead", () => {
    const earlier = { id: "first", role: "user", content: [{ type: "text", text: "status" }], timestamp: "2026-09-23T00:10:00.000Z" };
    const history = threadOf(convertHistoryToBlocks([
      earlier,
      { id: "second", role: "user", content: [{ type: "text", text: "status" }], timestamp: "2026-09-23T00:44:00.000Z" },
    ]));
    const live = threadOf([
      ...convertHistoryToBlocks([earlier]),
      optimisticUser("user-1790099999999", "status", "2026-09-23T00:49:00.000Z"),
    ]);
    expect(mergeHistoryWithLive(history, live).blocks.map((block) => block.id)).toEqual(["first", "second"]);
  });

  it("matches the first prompt of a client-created session despite clock skew", () => {
    const history = threadOf(convertHistoryToBlocks([
      { id: "first", role: "user", content: [{ type: "text", text: "start" }], timestamp: "2026-09-23T00:44:00.000Z" },
    ]));
    const live = threadOf([{ ...optimisticUser("user-1790099999999", "start", "2026-09-23T00:49:00.000Z"), optimisticFirstInSession: true } as ThreadBlock]);
    expect(mergeHistoryWithLive(history, live).blocks.map((block) => block.id)).toEqual(["first"]);
  });

  it("retains a repeated live prompt when the only matching durable copy precedes the shared block", () => {
    const history = threadOf(convertHistoryToBlocks([
      { id: "first", role: "user", content: [{ type: "text", text: "status" }], timestamp: "2026-09-23T00:10:00.000Z" },
      { id: "second", role: "user", content: [{ type: "text", text: "something else" }], timestamp: "2026-09-23T00:20:00.000Z" },
    ]));
    const live = threadOf([
      history.blocks[0], history.blocks[1],
      optimisticUser("user-1790099999999", "status", "2026-09-23T00:15:00.000Z"),
    ]);
    expect(mergeHistoryWithLive(history, live).blocks.map((block) => block.id))
      .toEqual(["first", "second", "user-1790099999999"]);
  });
});
