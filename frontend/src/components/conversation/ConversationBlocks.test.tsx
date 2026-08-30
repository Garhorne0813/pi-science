import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderBlocks, renderTurn } from "./ConversationBlocks";
import i18n from "../../i18n";
import type { CodeRunner } from "../markdown-viewer/MarkdownViewer";
import type { ThreadBlock, ToolCallBlock } from "../../types/thread";
import { buildTurnPresentations } from "../../lib/conversation/turn-presentation";
import { useRuntimeStore } from "../../lib/agent-runtime";

const codeRunner: CodeRunner = { cwd: "proj", sessionId: "s1" };
const user = (id: string, text = id): ThreadBlock => ({ kind: "user", id, text, timestamp: new Date().toISOString() });
const agent = (id: string, text: string, partial = false): ThreadBlock => ({ kind: "agent", id, parts: [{ id: `${id}-p0`, text }], ...(partial ? { partial: true } : {}) });
const tool = (id: string, name: string, status: ToolCallBlock["status"] = "done", input?: Record<string, unknown>): ThreadBlock => ({ kind: "tool", id, callId: `${id}-call`, tool: name, status, input, output: "output" });

beforeAll(async () => { await i18n.changeLanguage("en"); });
beforeEach(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } }); });
afterEach(() => { cleanup(); useRuntimeStore.setState({ thread: { blocks: [], index: {}, loaded: true } }); Reflect.deleteProperty(navigator, "clipboard"); });

describe("turn-level conversation rendering", () => {
  it("renders nothing for invalid input", () => {
    expect(renderBlocks(null as unknown as ThreadBlock[], codeRunner)).toBeNull();
    expect(renderBlocks({} as unknown as ThreadBlock[], codeRunner)).toBeNull();
  });

  it("renders one activity across narration-separated tools and hides intermediate narration", () => {
    render(<>{renderBlocks([
      user("u1", "check module"),
      agent("a1", "I will read the component."),
      tool("read", "read", "done", { path: "ConversationBlocks.tsx" }),
      agent("a2", "Now I will search events."),
      tool("grep", "grep", "done", { pattern: "tool.updated" }),
      agent("a3", "The final answer."),
    ], codeRunner)}</>);
    expect(screen.getByText("Complete")).toBeInTheDocument();
    expect(screen.getByLabelText("2 operations")).toBeInTheDocument();
    expect(screen.queryByText("I will read the component.")).not.toBeInTheDocument();
    expect(screen.queryByText("Now I will search events.")).not.toBeInTheDocument();
    expect(screen.getByText("The final answer.")).toBeInTheDocument();
  });

  it("excludes interleaved todo tools from the turn activity", () => {
    render(<>{renderBlocks([user("u1"), agent("a1", "planning"), tool("read", "read"), tool("todo", "todo"), agent("a2", "searching"), tool("grep", "grep"), tool("todo-2", "todo"), agent("final", "done")], codeRunner)}</>);
    expect(screen.getByText("Complete")).toBeInTheDocument();
    expect(screen.getByLabelText("2 operations")).toBeInTheDocument();
    expect(screen.queryByText(/todo/i)).not.toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("keeps tool-only unfinished narration hidden and shows the phase label", () => {
    const turn = buildTurnPresentations([user("u1"), agent("a1", "I will inspect it."), tool("read", "read", "running", { path: "event-fold.ts" })], { lastTurnLifecycle: "active" })[0];
    render(<>{renderTurn(turn, codeRunner)}</>);
    expect(screen.getByText("Reviewing the implementation")).toBeInTheDocument();
    expect(screen.queryByText("I will inspect it.")).not.toBeInTheDocument();
  });

  it("hides streaming answer prose until the turn lifecycle settles", () => {
    const turn = buildTurnPresentations([user("u1"), tool("read", "read"), agent("a1", "streaming answer")], { lastTurnLifecycle: "active" })[0];
    render(<>{renderTurn(turn, codeRunner)}</>);
    expect(screen.queryByText("streaming answer")).not.toBeInTheDocument();
    expect(screen.getByText("Reviewing the implementation")).toBeInTheDocument();
    cleanup();
    const settled = buildTurnPresentations([user("u1"), tool("read", "read"), agent("a1", "streaming answer")])[0];
    render(<>{renderTurn(settled, codeRunner)}</>);
    expect(screen.getByText("streaming answer")).toBeInTheDocument();
    expect(screen.getByText("Complete")).toBeInTheDocument();
    expect(screen.getByLabelText("1 operation")).toBeInTheDocument();
  });

  it("shows a completed summary when a settled turn ends on a tool", () => {
    render(<>{renderBlocks([user("u1"), agent("a1", "I will inspect it."), tool("read", "read")], codeRunner)}</>);
    expect(screen.getByText("Complete")).toBeInTheDocument();
    expect(screen.getByLabelText("1 operation")).toBeInTheDocument();
    expect(screen.queryByText("I will inspect it.")).not.toBeInTheDocument();
  });

  it("copies only the final visible answer", () => {
    render(<>{renderBlocks([user("u1", "question"), agent("a1", "hidden narration"), tool("read", "read"), agent("a2", "visible answer")], codeRunner)}</>);
    const userMessage = document.getElementById("user-msg-u1")!;
    const agentCopy = screen.getAllByRole("button", { name: "Copy" }).find((button) => !userMessage.contains(button));
    fireEvent.click(agentCopy!);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("visible answer");
  });

  it("keeps user bubble geometry", () => {
    render(<>{renderBlocks([user("u1", "hello")], codeRunner)}</>);
    const bubble = document.getElementById("user-msg-u1")!;
    expect(bubble).toHaveClass("max-w-[min(var(--user-message-width),82%)]");
    expect(bubble.querySelector(".ui-user-message")).toHaveClass("rounded-bubble", "px-4", "py-2.5");
  });

  it("renders artifacts after the final answer", () => {
    render(<>{renderBlocks([user("u1"), agent("a1", "final answer"), { kind: "artifact-summary", id: "turn-artifacts-t1", turnId: "t1", assistantMessageId: "a1", artifacts: [{ path: "work/plot.png", kind: "image", mime: "image/png", size: 10 }] }], codeRunner)}</>);
    expect(screen.getByText("final answer")).toBeInTheDocument();
    expect(screen.getByLabelText("Generated files")).toBeInTheDocument();
  });
});
