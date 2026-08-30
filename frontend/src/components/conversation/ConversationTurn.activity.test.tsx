/** End-to-end presentation check: real SSE tool/text events → folded thread →
 *  rendered conversation. Guards the PRD §40 cases (todo leakage, count, trace,
 *  snapshot recovery, live/history parity) through the same path the UI uses. */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderBlocks, renderTurn } from "./ConversationBlocks";
import { buildTurnPresentations } from "../../lib/conversation/turn-presentation";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { threadFromMessages } from "../../lib/agent-runtime/event-fold";
import { FakeEventSource, installRuntimeTestEnvironment, jsonResponse, state } from "../../lib/agent-runtime/test-helpers";
import { todoViewModel } from "../../lib/conversation/todos";
import i18n from "../../i18n";
import type { CodeRunner } from "../markdown-viewer/MarkdownViewer";
import type { HistoryMessage } from "../../lib/client/types";

const SESSION = "session-turn-it";
const codeRunner: CodeRunner = { cwd: "/workspace", sessionId: SESSION };
const planV1 = { action: "create", params: {}, nextId: 2, tasks: [{ id: 1, subject: "读 turn-presentation.ts", status: "in_progress", activeForm: "正在读取实现" }] };
const planV2 = { action: "update", params: { id: 1, status: "completed" }, nextId: 2, tasks: [{ id: 1, subject: "读 turn-presentation.ts", status: "completed" }] };

/** Narration → read → todo → narration → read → todo → bash → final answer. */
function emitTurn(): void {
  const source = FakeEventSource.instances[0];
  const emit = (type: string, payload: Record<string, unknown>) => source.emit(type, { type, sessionId: SESSION, ...payload });
  emit("agent_start", {});
  emit("text.updated", { partId: "m1", text: "我先读取 turn-presentation.ts。" });
  emit("tool.updated", { callId: "c1", tool: "read", status: "running", title: "Reading turn-presentation.ts", input: { path: "frontend/src/lib/conversation/turn-presentation.ts" }, startedAt: "2026-08-30T02:00:01.000Z" });
  emit("tool.updated", { callId: "c1", tool: "read", status: "done", title: "Reading turn-presentation.ts", output: "export function buildTurnPresentations", endedAt: "2026-08-30T02:00:02.000Z" });
  emit("tool.updated", { callId: "td1", tool: "todo", status: "running", input: { action: "create" }, startedAt: "2026-08-30T02:00:02.100Z" });
  emit("tool.updated", { callId: "td1", tool: "todo", status: "done", output: "Created #1", details: planV1, endedAt: "2026-08-30T02:00:02.200Z" });
  emit("text.updated", { partId: "m2", text: "接下来看事件折叠。" });
  emit("tool.updated", { callId: "c2", tool: "read", status: "running", title: "Reading event-fold.ts", input: { path: "frontend/src/lib/agent-runtime/event-fold.ts" }, startedAt: "2026-08-30T02:00:03.000Z" });
  emit("tool.updated", { callId: "c2", tool: "read", status: "done", title: "Reading event-fold.ts", output: "case \"tool.updated\"", endedAt: "2026-08-30T02:00:04.000Z" });
  emit("tool.updated", { callId: "td2", tool: "todo", status: "done", output: "Updated #1", details: planV2, endedAt: "2026-08-30T02:00:04.100Z" });
  emit("tool.updated", { callId: "c3", tool: "bash", status: "running", input: { command: "pnpm vitest run src/lib/conversation/turn-presentation.test.ts", description: "运行 turn 呈现层测试" }, startedAt: "2026-08-30T02:00:05.000Z" });
  emit("tool.updated", { callId: "c3", tool: "bash", status: "done", output: "7 passed", endedAt: "2026-08-30T02:00:06.000Z" });
  emit("text.updated", { partId: "m3", text: "实现符合方案：一个 turn 只有一个 Activity。" });
  emit("session.idle", {});
}

function stubWorkspace(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/messages")) return jsonResponse({ messages: [], next_cursor: null, has_more: false, snapshot_version: "v1" });
    if (url.includes("/state")) return jsonResponse(state(SESSION));
    if (url.startsWith("/api/sessions?")) return jsonResponse([]);
    throw new Error(`Unexpected request: ${url}`);
  }));
}

/** The history wire shape for the same turn (todo snapshot in toolResult details). */
function historyMessages(): HistoryMessage[] {
  return [
    { id: "u1", role: "user", content: [{ type: "text", text: "检查 turn 级 Activity 实现" }], timestamp: "2026-08-30T02:00:00.000Z" },
    { id: "m1", role: "assistant", content: [{ type: "text", text: "我先读取 turn-presentation.ts。" }, { type: "toolCall", id: "c1", name: "read" }] },
    { id: "r1", role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "export function buildTurnPresentations" }] },
    { id: "r2", role: "toolResult", toolCallId: "td1", toolName: "todo", content: [{ type: "text", text: "Created #1" }], details: planV1 },
    { id: "m2", role: "assistant", content: [{ type: "text", text: "接下来看事件折叠。" }, { type: "toolCall", id: "c2", name: "read" }, { type: "toolCall", id: "c3", name: "bash" }] },
    { id: "r3", role: "toolResult", toolCallId: "c2", toolName: "read", content: [{ type: "text", text: "case tool.updated" }] },
    { id: "r4", role: "toolResult", toolCallId: "c3", toolName: "bash", content: [{ type: "text", text: "7 passed" }] },
    { id: "r5", role: "toolResult", toolCallId: "td2", toolName: "todo", content: [{ type: "text", text: "Updated #1" }], details: planV2 },
    { id: "m3", role: "assistant", content: [{ type: "text", text: "实现符合方案：一个 turn 只有一个 Activity。" }] },
  ];
}

installRuntimeTestEnvironment();

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

describe("turn-level activity through the live event path", () => {
  it("renders one activity row, hides narration, and keeps the todo plan alive", async () => {
    stubWorkspace();
    await useRuntimeStore.getState().connect("/workspace", SESSION);
    emitTurn();

    const blocks = useRuntimeStore.getState().thread.blocks;
    const { container } = render(<>{renderBlocks(blocks, codeRunner)}</>);

    // One user turn => exactly one Current Activity row.
    expect(container.querySelectorAll("span[aria-live='polite']")).toHaveLength(1);
    // Execution tools only: 2 reads + 1 bash. Todo is plan-control.
    expect(screen.getByText("Complete")).toBeInTheDocument();
    expect(screen.getByLabelText("3 operations")).toBeInTheDocument();
    // Intermediate narration is suppressed; only the final answer is prose.
    expect(screen.queryByText("我先读取 turn-presentation.ts。")).not.toBeInTheDocument();
    expect(screen.queryByText("接下来看事件折叠。")).not.toBeInTheDocument();
    expect(screen.getByText(/实现符合方案/)).toBeInTheDocument();
    // PRD case D: hiding the todo ToolCard must not break Todo state recovery.
    const viewModel = todoViewModel(blocks);
    expect(viewModel?.total).toBe(1);
    expect(viewModel?.completed).toBe(1);
    expect(viewModel?.allCompleted).toBe(true);
  });

  it("shows the running phase label while the turn is still in flight", async () => {
    stubWorkspace();
    await useRuntimeStore.getState().connect("/workspace", SESSION);
    const source = FakeEventSource.instances[0];
    source.emit("agent_start", { type: "agent_start", sessionId: SESSION });
    source.emit("text.updated", { type: "text.updated", sessionId: SESSION, partId: "m1", text: "我先读取实现。" });
    source.emit("tool.updated", { type: "tool.updated", sessionId: SESSION, callId: "c1", tool: "read", status: "running", title: "Reading turn-presentation.ts", input: { path: "a.ts" } });

    const runtime = useRuntimeStore.getState();
    render(<>{buildTurnPresentations(runtime.thread.blocks, { lastTurnLifecycle: runtime.turnLifecycle }).map((turn) => renderTurn(turn, codeRunner))}</>);
    // Narrative label, not the per-tool title: the title stays in the trace.
    expect(screen.getByText("Reviewing the implementation")).toBeInTheDocument();
    expect(screen.queryByText("我先读取实现。")).not.toBeInTheDocument();
    expect(screen.queryByText("Complete")).not.toBeInTheDocument();
  });

  it("keeps todo bookkeeping out of the trace while the plan still shows", async () => {
    stubWorkspace();
    await useRuntimeStore.getState().connect("/workspace", SESSION);
    emitTurn();
    render(<>{renderBlocks(useRuntimeStore.getState().thread.blocks, codeRunner)}</>);

    fireEvent.click(screen.getByRole("button", { name: /Complete/ }));
    expect(screen.getByLabelText("Execution trace")).toBeInTheDocument();
    const traceLabels = Array.from(document.querySelectorAll("[aria-label='Execution trace'] button > span"));
    expect(traceLabels.map((node) => node.textContent)).toEqual([
      "Reading turn-presentation.ts",
      "Reading event-fold.ts",
      "运行 turn 呈现层测试",
    ]);
    // Todo never leaks as a trace row or an aria-live announcement source.
    expect(screen.queryByText(/Created #1|Updated #1/)).not.toBeInTheDocument();
  });
});

describe("turn-level activity through the history path", () => {
  it("rebuilds the same visible activity and todo plan after a refresh", () => {
    const thread = threadFromMessages(historyMessages());
    const { container } = render(<>{renderBlocks(thread.blocks, codeRunner)}</>);

    expect(container.querySelectorAll("span[aria-live='polite']")).toHaveLength(1);
    expect(screen.getByText("Complete")).toBeInTheDocument();
    expect(screen.getByLabelText("3 operations")).toBeInTheDocument();
    expect(screen.queryByText("我先读取 turn-presentation.ts。")).not.toBeInTheDocument();
    expect(screen.getByText(/实现符合方案/)).toBeInTheDocument();
    expect(todoViewModel(thread.blocks)?.allCompleted).toBe(true);
  });
});

describe("activity over time (PRD v1.2 §26/§28)", () => {
  it("streams provisional text, keeps one phase row, and confirms the answer at session.idle", async () => {
    stubWorkspace();
    await useRuntimeStore.getState().connect("/workspace", SESSION);
    vi.useFakeTimers();
    try {
      const source = FakeEventSource.instances[0];
      const emit = (type: string, payload: Record<string, unknown>) => source.emit(type, { type, sessionId: SESSION, ...payload });
      const view = () => {
        const state = useRuntimeStore.getState();
        return <>{buildTurnPresentations(state.thread.blocks, { lastTurnLifecycle: state.turnLifecycle }).map((turn) => renderTurn(turn, codeRunner))}</>;
      };
      const { rerender } = render(view());

      emit("agent_start", {});
      emit("text.updated", { partId: "m1", text: "我先检查一下。" });
      rerender(view());
      // The newest provisional block streams immediately. A later tool can
      // still supersede it as narration.
      expect(screen.getByLabelText("我先检查一下。")).toBeInTheDocument();
      expect(screen.queryByText("Reviewing the implementation")).not.toBeInTheDocument();

      emit("tool.updated", { callId: "r1", tool: "read", status: "running", input: { path: "a.ts" } });
      rerender(view());
      expect(screen.getByText("Reviewing the implementation")).toBeInTheDocument();
      expect(screen.queryByLabelText("我先检查一下。")).not.toBeInTheDocument();

      emit("tool.updated", { callId: "r1", tool: "read", status: "done" });
      emit("tool.updated", { callId: "r2", tool: "grep", status: "running", input: { pattern: "x" } });
      rerender(view());
      // More micro ops inside the same burst: no visible transition at all.
      expect(screen.getByText("Reviewing the implementation")).toBeInTheDocument();

      emit("tool.updated", { callId: "r2", tool: "grep", status: "done" });
      emit("tool.updated", { callId: "e1", tool: "edit", status: "running", input: { path: "b.ts" } });
      rerender(view());
      expect(screen.getByText("Reviewing the implementation")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(900); });
      expect(screen.getByText("Updating and verifying the implementation")).toBeInTheDocument();

      emit("tool.updated", { callId: "e1", tool: "edit", status: "done" });
      emit("tool.updated", { callId: "b1", tool: "bash", status: "running", input: { command: "pnpm vitest run", description: "运行测试" } });
      rerender(view());
      expect(screen.getByText("Updating and verifying the implementation")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(900); });
      expect(screen.getByText("Updating and verifying the implementation")).toBeInTheDocument();

      emit("tool.updated", { callId: "b1", tool: "bash", status: "done" });
      emit("text.updated", { partId: "m2", text: "这是最终回答。" });
      rerender(view());
      // The final answer is visible while its text is still streaming.
      expect(screen.getByLabelText("这是最终回答。")).toBeInTheDocument();
      expect(screen.getByText("Updating and verifying the implementation")).toBeInTheDocument();

      emit("session.idle", {});
      rerender(view());
      expect(screen.getByText("这是最终回答。")).toBeInTheDocument();
      expect(screen.getByText("Complete")).toBeInTheDocument();
      expect(screen.getByLabelText("4 operations")).toBeInTheDocument();
      expect(screen.queryByText("我先检查一下。")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
