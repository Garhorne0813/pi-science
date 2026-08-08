import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { groupBlocks, renderBlockGroup, renderBlocks } from "./ConversationBlocks";
import i18n from "../../i18n";
import type { CodeRunner } from "../markdown-viewer/MarkdownViewer";
import type { ThreadBlock } from "../../types/thread";
import { useRuntimeStore } from "../../lib/agent-runtime";

const codeRunner: CodeRunner = { cwd: "proj", sessionId: "s1" };

function user(id: string, text: string): ThreadBlock {
  return { kind: "user", id, text, timestamp: new Date().toISOString() };
}

function agent(id: string, text: string): ThreadBlock {
  return { kind: "agent", id, parts: [{ id: `${id}-p0`, text }] };
}

function tool(id: string, name: string): ThreadBlock {
  return { kind: "tool", id, callId: `${id}-call`, tool: name, status: "done", output: "output" };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  cleanup();
  useRuntimeStore.setState({ thread: { blocks: [], index: {}, loaded: true } });
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("groupBlocks", () => {
  it("returns an empty grouping for non-array input instead of throwing", () => {
    expect(groupBlocks(null as unknown as ThreadBlock[])).toEqual([]);
    expect(groupBlocks(undefined as unknown as ThreadBlock[])).toEqual([]);
    expect(groupBlocks("garbage" as unknown as ThreadBlock[])).toEqual([]);
  });
});

describe("renderBlocks", () => {
  it("renders nothing for non-array input instead of throwing", () => {
    expect(renderBlocks(null as unknown as ThreadBlock[], codeRunner)).toBeNull();
    expect(renderBlocks(undefined as unknown as ThreadBlock[], codeRunner)).toBeNull();
    expect(renderBlocks({} as unknown as ThreadBlock[], codeRunner)).toBeNull();
  });

  it("shows the copy action only on the final assistant answer, with the whole turn's text", () => {
    render(<>{renderBlocks([
      user("u1", "do the thing"),
      agent("a1", "Let me check that for you."),
      tool("t1", "read"),
      agent("a2", "Here is the final answer."),
    ], codeRunner)}</>);

    // One copy button on the user message, one on the final assistant block —
    // the assistant narration before the tool call has none.
    const copyButtons = screen.getAllByRole("button", { name: "Copy" });
    expect(copyButtons).toHaveLength(2);
    const userMessage = document.getElementById("user-msg-u1")!;
    const agentCopy = copyButtons.find((button) => !userMessage.contains(button));
    expect(agentCopy).toBeDefined();

    fireEvent.click(agentCopy!);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "Let me check that for you.\n\nHere is the final answer.",
    );
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
});

describe("renderBlockGroup", () => {
  it("prefers the whole-thread action map over a per-group computation", () => {
    const wholeThread = new Map([["a2", "final only"]]);
    render(<>{renderBlockGroup([agent("a1", "narration")], codeRunner, wholeThread)}</>);

    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();

    cleanup();
    render(<>{renderBlockGroup([agent("a2", "final")], codeRunner, wholeThread)}</>);
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("shows one copy action for a response split across tool groups", () => {
    render(<>{renderBlocks([
      agent("a1", "好的，我来探索工作区的现有数据。先看一下整体结构。"),
      tool("ls", "bash"),
      agent("a2", "venv 内容淹没了输出，我排除它再看实际的工作文件。"),
      tool("find", "bash"),
      agent("a3", "工作区内容很精简。现在看一下脚本、数据和已有图。"),
      tool("read", "bash"),
      agent("a4", "已完成探索。"),
    ], codeRunner)}</>);

    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(1);
  });
});

describe("artifact-summary blocks", () => {
  it("renders the turn artifact strip after the final agent message", () => {
    render(<>{renderBlocks([
      agent("a1", "final answer"),
      { kind: "artifact-summary", id: "turn-artifacts-t1", turnId: "t1", assistantMessageId: "a1", artifacts: [{ path: "work/plot.png", kind: "image", mime: "image/png", size: 10 }] },
    ], codeRunner)}</>);

    expect(screen.getByLabelText("Generated files")).toBeInTheDocument();
    expect(screen.getByAltText("plot.png")).toBeInTheDocument();
  });
});
