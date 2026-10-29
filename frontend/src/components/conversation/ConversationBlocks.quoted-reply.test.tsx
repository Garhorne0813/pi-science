import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { renderBlocks } from "./ConversationBlocks";
import i18n from "../../i18n";
import type { CodeRunner } from "../markdown-viewer/MarkdownViewer";
import type { AgentMessageBlock, ThreadBlock } from "../../types/thread";
import { composeQuotedPrompt } from "../../lib/conversation/quoted-message";

const codeRunner: CodeRunner = { cwd: "proj", sessionId: "s1" };
const quote = { source: { role: "agent" as const, blockId: "a1" }, kind: "selection" as const, text: "then report." };

const agent = (id: string, turnId: string, text: string): AgentMessageBlock => ({ kind: "agent", id, turnId, parts: [{ id: `${id}-p0`, text }] });
const user = (id: string, turnId: string, text: string): ThreadBlock => ({ kind: "user", id, turnId, text });

beforeAll(async () => { await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); });

describe("a sent quoted reply", () => {
  it("shows the quoted text and the question, not the machine block", () => {
    render(<div>{renderBlocks([agent("a1", "t1", "Read the log twice, then report."), user("u1", "t1", composeQuotedPrompt(quote, "why twice?"))], codeRunner)}</div>);

    expect(screen.getByText("then report.")).toBeTruthy();
    expect(screen.getByText("why twice?")).toBeTruthy();
    expect(screen.queryByText(/<quoted_message/)).toBeNull();
    expect(screen.getByText("Assistant · Selected text")).toBeTruthy();
  });

  it("anchors both messages so a pending quote can find its source", () => {
    const { container } = render(<div>{renderBlocks([agent("a1", "t1", "Read the log twice, then report."), user("u1", "t1", "why twice?")], codeRunner)}</div>);
    expect(container.querySelector("#agent-msg-a1")).toBeTruthy();
    expect(container.querySelector("#user-msg-u1")).toBeTruthy();
  });
});
