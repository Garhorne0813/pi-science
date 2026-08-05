import { describe, expect, it, vi } from "vitest";

import { convertHistoryToBlocks, useRuntimeStore } from "./index";
import { FakeEventSource, installRuntimeTestEnvironment, jsonResponse, state } from "./test-helpers";


installRuntimeTestEnvironment();


describe("transport event folding", () => {
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
    });
    source.emit("tool.updated", {
      type: "tool.updated",
      sessionId: "session-a",
      callId: "call-1",
      tool: "",
      status: "done",
    });

    expect(useRuntimeStore.getState().thread.blocks).toContainEqual(
      expect.objectContaining({ kind: "tool", callId: "call-1", tool: "bash", status: "done" }),
    );
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
