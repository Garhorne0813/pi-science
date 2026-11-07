import { describe, expect, it } from "vitest";
import { composeQuotedPrompt, messageAnchorId, quotedMessageBlock, quotedMessagesFromMessage, stripQuotedMessageBlocks } from "./quoted-message";

const agentSelection = { source: { role: "agent" as const, blockId: "a1" }, kind: "selection" as const, text: "then report." };

describe("quotedMessageBlock", () => {
  it("names the source role and whether the quote is an excerpt", () => {
    expect(quotedMessageBlock(agentSelection)).toBe('<quoted_message role="agent" kind="selection">\nthen report.\n</quoted_message>');
    expect(quotedMessageBlock({ source: { role: "user", blockId: "u1" }, kind: "message", text: "Read the log" }))
      .toBe('<quoted_message role="user" kind="message">\nRead the log\n</quoted_message>');
  });
});

describe("composeQuotedPrompt", () => {
  it("puts the user's own question after the quote", () => {
    expect(composeQuotedPrompt(agentSelection, "why twice?")).toBe('<quoted_message role="agent" kind="selection">\nthen report.\n</quoted_message>\n\nwhy twice?');
  });

  it("sends the quote alone when the user wrote no question", () => {
    expect(composeQuotedPrompt(agentSelection, "")).toBe('<quoted_message role="agent" kind="selection">\nthen report.\n</quoted_message>');
  });

  it("never shortens the quoted text, however long it is", () => {
    const text = Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n");
    const prompt = composeQuotedPrompt({ ...agentSelection, text }, "summarise");
    expect(prompt).toContain(text);
    expect(prompt.endsWith("summarise")).toBe(true);
  });

  it("keeps the indent and the trailing newline of a code selection", () => {
    const text = "def f():\n    return 1\n";
    const prompt = composeQuotedPrompt({ ...agentSelection, text }, "fix it");
    expect(quotedMessagesFromMessage(prompt)[0]?.text).toBe(text);
  });
});

describe("quotedMessagesFromMessage", () => {
  it("round-trips the block the composer sent", () => {
    const prompt = composeQuotedPrompt(agentSelection, "why twice?");
    expect(quotedMessagesFromMessage(prompt)).toEqual([{ role: "agent", kind: "selection", text: "then report." }]);
    expect(stripQuotedMessageBlocks(prompt)).toBe("why twice?");
  });

  it("reports no quote for an ordinary message", () => {
    expect(quotedMessagesFromMessage("Read the log")).toEqual([]);
    expect(stripQuotedMessageBlocks("Read the log")).toBe("Read the log");
  });
});

describe("messageAnchorId", () => {
  it("names the anchor each message renderer uses", () => {
    expect(messageAnchorId({ role: "user", blockId: "u1" })).toBe("user-msg-u1");
    expect(messageAnchorId({ role: "agent", blockId: "a1" })).toBe("agent-msg-a1");
  });
});
