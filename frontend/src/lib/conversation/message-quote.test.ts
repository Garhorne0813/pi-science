import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useRuntimeStore } from "../agent-runtime";
import { buildMessageQuote, selectedTextWithin, useActiveMessageQuote, useMessageQuoteStore, type MessageQuoteSource } from "./message-quote";

const source: MessageQuoteSource = { workspaceCwd: "proj", sessionId: "s1", blockId: "u1", role: "user" };

beforeEach(() => {
  useMessageQuoteStore.setState({ quotes: {} });
  useRuntimeStore.setState({ cwd: "proj", activeSessionId: "s1" });
});

describe("buildMessageQuote", () => {
  it("produces no quote when there is no message text", () => {
    expect(buildMessageQuote({ source, messageText: "" })).toBeNull();
    expect(buildMessageQuote({ source, messageText: "   \n\t " })).toBeNull();
    expect(buildMessageQuote({ source, messageText: "  ", selection: "text" })).toBeNull();
  });

  it("quotes the whole message verbatim when nothing is selected", () => {
    expect(buildMessageQuote({ source, messageText: "Read the log" })).toEqual({
      source,
      kind: "message",
      text: "Read the log",
      messageText: "Read the log",
    });
  });

  it("treats a selection equal to the whole message as a whole-message quote", () => {
    expect(buildMessageQuote({ source, messageText: "Read the log", selection: " Read the log " })).toEqual({
      source,
      kind: "message",
      text: "Read the log",
      messageText: "Read the log",
    });
  });

  it("keeps the exact fragment and the whole message for a selection", () => {
    expect(buildMessageQuote({ source, messageText: "Read the log twice, then report.", selection: "then report." })).toEqual({
      source,
      kind: "selection",
      text: "then report.",
      messageText: "Read the log twice, then report.",
    });
  });

  it("keeps the indent of a code selection", () => {
    const messageText = "Run this:\n\n```python\ndef f():\n    return 1\n```";
    expect(buildMessageQuote({ source, messageText, selection: "    return 1" })).toEqual({
      source,
      kind: "selection",
      text: "    return 1",
      messageText,
    });
  });
});

describe("selectedTextWithin", () => {
  const message = (): HTMLElement => {
    const element = document.createElement("div");
    element.innerHTML = '<p>Read the log twice</p><div data-quote-exclude=""><pre>42</pre></div>';
    document.body.append(element);
    return element;
  };
  const select = (start: Node, startOffset: number, end: Node, endOffset: number) => {
    const range = document.createRange();
    range.setStart(start, startOffset);
    range.setEnd(end, endOffset);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  };

  afterEach(() => {
    document.body.innerHTML = "";
    window.getSelection()?.removeAllRanges();
  });

  it("reads a selection that lies inside the message text", () => {
    const element = message();
    const prose = element.querySelector("p")!.firstChild!;
    select(prose, 5, prose, 12);
    expect(selectedTextWithin(element)).toBe("the log");
  });

  it("refuses code run output, which the message text never contained", () => {
    const element = message();
    const output = element.querySelector("pre")!.firstChild!;
    select(output, 0, output, 2);
    expect(selectedTextWithin(element)).toBeNull();
  });

  it("refuses a selection that starts in the message and ends in run output", () => {
    const element = message();
    select(element.querySelector("p")!.firstChild!, 0, element.querySelector("pre")!.firstChild!, 2);
    expect(selectedTextWithin(element)).toBeNull();
  });

  it("refuses a selection that reaches into another message", () => {
    const element = message();
    const other = document.createElement("p");
    other.textContent = "another message";
    document.body.append(other);
    select(element.querySelector("p")!.firstChild!, 0, other.firstChild!, 15);
    expect(selectedTextWithin(element)).toBeNull();
  });
});

describe("useActiveMessageQuote", () => {
  it("shows a quote only inside the conversation that filed it", () => {
    const quote = buildMessageQuote({ source, messageText: "Read the log" });
    if (!quote) throw new Error("expected a whole-message quote");
    const { result } = renderHook(() => useActiveMessageQuote());
    expect(result.current).toBeNull();

    act(() => useMessageQuoteStore.getState().setQuote(quote));
    expect(result.current).toEqual(quote);

    act(() => useRuntimeStore.setState({ activeSessionId: "s2" }));
    expect(result.current).toBeNull();

    act(() => useRuntimeStore.setState({ cwd: "other", activeSessionId: "s1" }));
    expect(result.current).toBeNull();

    act(() => useRuntimeStore.setState({ cwd: "proj", activeSessionId: "s1" }));
    expect(result.current).toEqual(quote);
  });

  it("still shows a pending quote after the backend re-issues the session id", () => {
    const quote = buildMessageQuote({ source, messageText: "Read the log" });
    if (!quote) throw new Error("expected a whole-message quote");
    const { result } = renderHook(() => useActiveMessageQuote());

    act(() => useMessageQuoteStore.getState().setQuote(quote));
    act(() => useMessageQuoteStore.getState().migrateSession({ workspaceCwd: "proj", sessionId: "s1" }, "s2"));
    act(() => useRuntimeStore.setState({ activeSessionId: "s2" }));

    expect(result.current?.text).toBe("Read the log");
    expect(result.current?.source.sessionId).toBe("s2");
    expect(Object.keys(useMessageQuoteStore.getState().quotes)).toEqual(["proj\u0000s2"]);
  });

  it("leaves the store alone when the id is unchanged or no quote is filed", () => {
    const quote = buildMessageQuote({ source, messageText: "Read the log" });
    if (!quote) throw new Error("expected a whole-message quote");

    act(() => useMessageQuoteStore.getState().setQuote(quote));
    act(() => useMessageQuoteStore.getState().migrateSession({ workspaceCwd: "proj", sessionId: "s1" }, "s1"));
    act(() => useMessageQuoteStore.getState().migrateSession({ workspaceCwd: "proj", sessionId: "absent" }, "s9"));

    expect(Object.keys(useMessageQuoteStore.getState().quotes)).toEqual(["proj\u0000s1"]);
  });
});
