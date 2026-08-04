import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { groupBlocks, renderBlockGroup, renderBlocks } from "./ConversationBlocks";
import i18n from "../../i18n";
import type { CodeRunner } from "../markdown-viewer/MarkdownViewer";
import type { ThreadBlock } from "../../types/thread";

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
});
