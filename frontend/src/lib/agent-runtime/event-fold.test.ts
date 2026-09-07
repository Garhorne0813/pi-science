import { describe, expect, it, vi } from "vitest";

import { convertHistoryToBlocks, mergeHistoryWindow, replaceHistoryTail, useRuntimeStore } from "./index";
import { threadFromMessages, type Thread } from "./event-fold";
import type { HistoryMessage } from "../client/types";
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
