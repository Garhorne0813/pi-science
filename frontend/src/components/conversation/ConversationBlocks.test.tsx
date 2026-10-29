import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderBlocks, renderTurn } from "./ConversationBlocks";
import i18n from "../../i18n";
import type { CodeRunner } from "../markdown-viewer/MarkdownViewer";
import type { AgentMessageBlock, ThreadBlock, ToolCallBlock } from "../../types/thread";
import { buildTurnPresentations } from "../../lib/conversation/turn-presentation";
import { selectedTextWithin, useMessageQuoteStore } from "../../lib/conversation/message-quote";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { RunnableCodeBlock } from "./RunnableCodeBlock";

const codeRunner: CodeRunner = { cwd: "proj", sessionId: "s1" };
const user = (id: string, text = id): ThreadBlock => ({ kind: "user", id, text, timestamp: new Date().toISOString() });
const agent = (id: string, text: string, partial = false): AgentMessageBlock => ({ kind: "agent", id, parts: [{ id: `${id}-p0`, text }], ...(partial ? { partial: true } : {}) });
const tool = (id: string, name: string, status: ToolCallBlock["status"] = "done", input?: Record<string, unknown>): ThreadBlock => ({ kind: "tool", id, callId: `${id}-call`, tool: name, status, input, output: "output" });

beforeAll(async () => { await i18n.changeLanguage("en"); });
beforeEach(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } }); });
afterEach(() => { cleanup(); useRuntimeStore.setState({ thread: { blocks: [], index: {}, loaded: true } }); useMessageQuoteStore.setState({ quotes: {} }); window.getSelection()?.removeAllRanges(); Reflect.deleteProperty(navigator, "clipboard"); });

const selectRange = (start: Node, startOffset: number, end: Node, endOffset: number) => {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent(document, new Event("selectionchange"));
};
const quoteMenu = () => screen.queryByRole("button", { name: "Quote selection" });

describe("turn-level conversation rendering", () => {
  it("keeps an optimistic prompt visible without a send-confirmation banner", () => {
    render(<>{renderBlocks([{ kind: "user", id: "u1", text: "status", deliveryStatus: "pending", client_message_id: "8fd824aa-51d3-4f63-839c-09e021b7970b" }], codeRunner)}</>);
    expect(screen.getByText("status")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("offers a same-ID retry for a definitely rejected request", () => {
    render(<>{renderBlocks([{ kind: "user", id: "u1", text: "status", deliveryStatus: "rejected", client_message_id: "8fd824aa-51d3-4f63-839c-09e021b7970b" }], codeRunner)}</>);
    expect(screen.getByRole("button", { name: /same request ID/i })).toBeTruthy();
  });

  it("renders nothing for invalid input", () => {
    expect(renderBlocks(null as unknown as ThreadBlock[], codeRunner)).toBeNull();
    expect(renderBlocks({} as unknown as ThreadBlock[], codeRunner)).toBeNull();
  });

  it("folds intermediate narration across narration-separated tools once the turn settles", () => {
    render(<>{renderBlocks([
      user("u1", "check module"),
      agent("a1", "I will read the component."),
      tool("read", "read", "done", { path: "ConversationBlocks.tsx" }),
      agent("a2", "Now I will search events."),
      tool("grep", "grep", "done", { pattern: "tool.updated" }),
      agent("a3", "The final answer."),
    ], codeRunner)}</>);
    expect(screen.queryByText("I will read the component.")).not.toBeInTheDocument();
    expect(screen.queryByText("Now I will search events.")).not.toBeInTheDocument();
    expect(screen.getByText(/Complete|Encountered a problem|Stopped|Working/)).toBeInTheDocument();
    expect(screen.getByText("The final answer.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Complete|Encountered a problem|Stopped/ }));
    expect(screen.getByText("I will read the component.")).toBeInTheDocument();
    expect(screen.getByText("Now I will search events.")).toBeInTheDocument();
  });

  it("excludes interleaved todo tools from the turn activity", () => {
    render(<>{renderBlocks([user("u1"), agent("a1", "planning"), tool("read", "read"), tool("todo", "todo"), agent("a2", "searching"), tool("grep", "grep"), tool("todo-2", "todo"), agent("final", "done")], codeRunner)}</>);
    expect(screen.queryByText("planning")).not.toBeInTheDocument();
    expect(screen.queryByText("searching")).not.toBeInTheDocument();
    expect(screen.getByText(/Complete|Encountered a problem|Stopped|Working/)).toBeInTheDocument();
    expect(screen.queryByText(/todo/i)).not.toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Complete|Encountered a problem|Stopped/ }));
    expect(screen.getByText("planning")).toBeInTheDocument();
    expect(screen.getByText("searching")).toBeInTheDocument();
    expect(screen.queryByText(/todo/i)).not.toBeInTheDocument();
  });

  it("shows process narration while tools are running", () => {
    const turn = buildTurnPresentations([user("u1"), agent("a1", "I will inspect it."), tool("read", "read", "running", { path: "event-fold.ts" })], { lastTurnLifecycle: "active" })[0];
    render(<>{renderTurn(turn, codeRunner)}</>);
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByText("I will inspect it.")).toBeInTheDocument();
  });

  it("shows streaming answer prose before the turn lifecycle settles", () => {
    const turn = buildTurnPresentations([user("u1"), tool("read", "read"), agent("a1", "streaming answer", true)], { lastTurnLifecycle: "active" })[0];
    render(<>{renderTurn(turn, codeRunner)}</>);
    expect(screen.getByText("streaming answer")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
    cleanup();
    const settled = buildTurnPresentations([user("u1"), tool("read", "read"), agent("a1", "streaming answer")])[0];
    render(<>{renderTurn(settled, codeRunner)}</>);
    expect(screen.getByText("streaming answer")).toBeInTheDocument();
    expect(screen.getByText(/Complete|Encountered a problem|Stopped|Working/)).toBeInTheDocument();
    expect(screen.queryByText("Reading file")).not.toBeInTheDocument();
    expect(screen.queryByText("Complete", { ignore: ".sr-only" })).not.toBeInTheDocument();
  });

  it("shows a completed summary when a settled turn ends on a tool", () => {
    render(<>{renderBlocks([user("u1"), agent("a1", "I will inspect it."), tool("read", "read")], codeRunner)}</>);
    expect(screen.getByText(/Complete|Encountered a problem|Stopped|Working/)).toBeInTheDocument();
    expect(screen.queryByText("Complete", { ignore: ".sr-only" })).not.toBeInTheDocument();
    expect(screen.queryByText("I will inspect it.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Complete|Encountered a problem|Stopped/ }));
    expect(screen.getByText("I will inspect it.")).toBeInTheDocument();
  });

  it("keeps an explicit final visible when later read-only verification completes", () => {
    render(<>{renderBlocks([
      user("u1", "generate an artifact"),
      { ...agent("final", "Generated the artifact successfully."), presentationRole: "final" as const },
      tool("verify", "read", "done", { path: "work/result.svg" }),
      { ...agent("verification", "Verification confirmed the generated file."), presentationRole: "intermediate" as const },
    ], codeRunner)}</>);

    expect(screen.getByText("Generated the artifact successfully.")).toBeInTheDocument();
    expect(screen.queryByText("Verification confirmed the generated file.")).not.toBeInTheDocument();
    const summary = screen.getByText(/Complete|Encountered a problem|Stopped|Working/);
    fireEvent.click(summary);
    expect(screen.getByText("Verification confirmed the generated file.")).toBeInTheDocument();
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

describe("message quoting", () => {
  it("quotes the selected fragment of one message and keeps it through the menu click", () => {
    render(<>{renderBlocks([user("u1", "question"), agent("a1", "Read the log twice")], codeRunner)}</>);
    const prose = screen.getByText("Read the log twice").firstChild!;
    selectRange(prose, 5, prose, 12);

    fireEvent.click(quoteMenu()!);

    expect(quoteMenu()).not.toBeInTheDocument();
    expect(Object.values(useMessageQuoteStore.getState().quotes)).toEqual([
      expect.objectContaining({ kind: "selection", text: "the log", messageText: "Read the log twice" }),
    ]);
  });

  it("offers no quote for a selection that spans two messages", () => {
    render(<>{renderBlocks([user("u1", "alpha first"), agent("a1", "beta second")], codeRunner)}</>);
    selectRange(screen.getByText("alpha first").firstChild!, 0, screen.getByText("beta second").firstChild!, 4);
    expect(quoteMenu()).not.toBeInTheDocument();
  });

  it("re-anchors the menu when the conversation scrolls under it", () => {
    let top = 100;
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top, left: 200, width: 10, height: 10, bottom: top + 10, right: 210, x: 200, y: top, toJSON: () => ({}) }),
    });
    try {
      render(<>{renderBlocks([user("u1", "question"), agent("a1", "Read the log twice")], codeRunner)}</>);
      const prose = screen.getByText("Read the log twice").firstChild!;
      selectRange(prose, 5, prose, 12);
      expect(quoteMenu()!.style.top).toBe("94px");

      top = 40;
      fireEvent.scroll(document);

      expect(quoteMenu()!.style.top).toBe("34px");
      expect(quoteMenu()!.style.left).toBe("205px");
    } finally {
      Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    }
  });

  it("refuses code run output, which exists only in the runner panel", () => {
    const { container } = render(<RunnableCodeBlock code="print(42)" language="python" running={false} result={{ ok: true, stdout: "42", result: null, error: null }} onRun={() => {}} onCloseResult={() => {}}><code>print(42)</code></RunnableCodeBlock>);
    const frame = container.firstElementChild as HTMLElement;
    const output = container.querySelector("[data-quote-exclude] pre")!.firstChild!;
    selectRange(output, 0, output, 2);
    expect(selectedTextWithin(frame)).toBeNull();

    const code = container.querySelector("code")!.firstChild!;
    selectRange(code, 0, code, 9);
    expect(selectedTextWithin(frame)).toBe("print(42)");
  });
});
