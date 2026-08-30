import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderBlocks, renderTurn } from "./ConversationBlocks";
import i18n from "../../i18n";
import type { CodeRunner } from "../markdown-viewer/MarkdownViewer";
import type { ThreadBlock, ToolCallBlock } from "../../types/thread";
import { buildTurnPresentations } from "../../lib/conversation/turn-presentation";
import { useRuntimeStore } from "../../lib/agent-runtime";

vi.mock("react-router-dom", async (importOriginal) => ({ ...await importOriginal<typeof import("react-router-dom")>(), useNavigate: () => vi.fn() }));
vi.mock("../feedback/feedback-context", () => ({ useFeedback: () => ({ toast: vi.fn() }) }));

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
    expect(screen.getByText("Completed · 2 operations")).toBeInTheDocument();
    expect(screen.queryByText("I will read the component.")).not.toBeInTheDocument();
    expect(screen.queryByText("Now I will search events.")).not.toBeInTheDocument();
    expect(screen.getByText("The final answer.")).toBeInTheDocument();
  });

  it("excludes interleaved todo tools from the turn activity", () => {
    render(<>{renderBlocks([user("u1"), agent("a1", "planning"), tool("read", "read"), tool("todo", "todo"), agent("a2", "searching"), tool("grep", "grep"), tool("todo-2", "todo"), agent("final", "done")], codeRunner)}</>);
    expect(screen.getByText("Completed · 2 operations")).toBeInTheDocument();
    expect(screen.queryByText(/todo/i)).not.toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("keeps tool-only unfinished narration hidden", () => {
    const turn = buildTurnPresentations([user("u1"), agent("a1", "I will inspect it."), tool("read", "read", "running", { path: "event-fold.ts" })])[0];
    render(<>{renderTurn(turn, codeRunner, undefined, true)}</>);
    expect(screen.getByText("Reading event-fold.ts")).toBeInTheDocument();
    expect(screen.queryByText("I will inspect it.")).not.toBeInTheDocument();
  });

  it("shows a completed summary when a settled turn ends on a tool", () => {
    render(<>{renderBlocks([user("u1"), agent("a1", "I will inspect it."), tool("read", "read")], codeRunner)}</>);
    expect(screen.getByText("Completed · 1 operations")).toBeInTheDocument();
    expect(screen.queryByText("I will inspect it.")).not.toBeInTheDocument();
  });

  it("copies only the final visible answer", () => {
    render(<>{renderBlocks([user("u1", "question"), agent("a1", "hidden narration"), tool("read", "read"), agent("a2", "visible answer")], codeRunner)}</>);
    const userMessage = document.getElementById("user-msg-u1")!;
    const agentCopy = screen.getAllByRole("button", { name: "Copy" }).find((button) => !userMessage.contains(button));
    fireEvent.click(agentCopy!);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("visible answer");
  });

  it("hides the copy action when the turn ends on a tool call with no final assistant answer", () => {
    render(<>{renderBlocks([
      user("u1", "do the thing"),
      agent("a1", "Working on it."),
      tool("t1", "read"),
    ], codeRunner)}</>);

    // Only the user message has a copy button; the tool-call narration does not.
    const copyButtons = screen.getAllByRole("button", { name: "Copy" });
    expect(copyButtons).toHaveLength(1);
  });

  it("renders a scheduled-task proposal fence as a confirmation card", () => {
    const proposal = `I prepared this task.\n\n\`\`\`scheduled-task-proposal\n{"proposal_id":"p1","title":"CRISPR watch","task_kind":"literature_monitor","description":"Watch papers","schedule":{"display_text":"Every weekday · 09:00 · UTC","canonical":{"type":"cron","expression":"0 9 * * 1-5","timezone":"UTC"}},"action_summary":"Track CRISPR papers","delivery_policy":"only_when_relevant","query":"CRISPR screening","providers":["pubmed"]}\n\`\`\``;
    render(<>{renderBlocks([agent("a1", proposal)], codeRunner)}</>);

    expect(screen.getByText("I prepared this task.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Scheduled task proposal" })).toHaveTextContent("CRISPR watch");
    expect(screen.getByRole("button", { name: "Schedule & run now" })).toBeInTheDocument();
    expect(screen.queryByText(/proposal_id/)).not.toBeInTheDocument();
  });

  it("does not make an unconfirmed planned path clickable", () => {
    useRuntimeStore.setState({ thread: { blocks: [], index: {}, loaded: true } });
    render(<>{renderBlocks([
      agent("a1", "计划输出 `drafts/structure_prediction_research_brief.md`。"),
    ], codeRunner)}</>);

    expect(screen.queryByRole("button", { name: /drafts\/structure_prediction_research_brief\.md/ })).not.toBeInTheDocument();
  });

  it("does not render file-reference chips even for published artifact paths (cards replace them)", () => {
    useRuntimeStore.setState({ thread: { blocks: [], index: {}, loaded: true } });
    render(<>{renderBlocks([
      agent("a1", "生成完成：`work/plot.png` 和 `work/results.csv`。"),
      { kind: "status-line", id: "st1", text: "artifact ready", level: "done", path: "work/plot.png" },
      { kind: "artifact-summary", id: "turn-artifacts-t1", turnId: "t1", assistantMessageId: "a1", artifacts: [{ path: "work/plot.png", kind: "image", mime: "image/png", size: 10 }, { path: "work/results.csv", kind: "table", mime: "text/csv", size: 10 }] },
    ], codeRunner)}</>);

    // The paths are published (status-line done + artifact-summary), but the
    // per-message chip row is gone — the turn artifact cards are the single source.
    // Exact name match: the old chips exposed the bare path as their accessible
    // name, while the artifact cards use an aria-label like "plot.png (work/plot.png)",
    // so an exact "work/plot.png" lookup only ever matches the removed chips.
    expect(screen.queryByRole("button", { name: "work/plot.png" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "work/results.csv" })).not.toBeInTheDocument();
    // The strip itself still renders (its cards use img/alt or aria-label, not button text).
    expect(screen.getByLabelText("Generated files")).toBeInTheDocument();
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
