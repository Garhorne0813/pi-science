import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MessageQuoteCard } from "./MessageQuoteCard";
import i18n from "../../i18n";
import type { MessageQuote } from "../../lib/conversation/message-quote";

const quote = (overrides: Partial<MessageQuote> = {}): MessageQuote => ({
  source: { workspaceCwd: "proj", sessionId: "s1", blockId: "a1", role: "agent" },
  kind: "selection",
  text: "then report.",
  messageText: "Read the log twice, then report.",
  ...overrides,
});

beforeAll(async () => { await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("MessageQuoteCard", () => {
  it("shows the source role, the excerpt kind and the quoted text", () => {
    render(<MessageQuoteCard quote={quote()} onRemove={() => undefined} />);
    expect(screen.getByText("Assistant")).toBeTruthy();
    expect(screen.getByText("Selected text")).toBeTruthy();
    expect(screen.getByText("then report.")).toBeTruthy();
  });

  it("marks a whole-message quote as a whole message", () => {
    render(<MessageQuoteCard quote={quote({ source: { ...quote().source, role: "user", blockId: "u1" }, kind: "message", text: "Read the log", messageText: "Read the log" })} onRemove={() => undefined} />);
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Whole message")).toBeTruthy();
  });

  it("folds a long quote and unfolds it, with the whole source message on request", () => {
    const text = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    render(<MessageQuoteCard quote={quote({ text, messageText: `${text}\nthe rest of the message` })} onRemove={() => undefined} />);
    const toggle = screen.getByRole("button", { name: /show full text/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Full message")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Full message")).toBeTruthy();
    expect(screen.getByText("Collapse")).toBeTruthy();
  });

  it("offers no fold for a quote that fits", () => {
    render(<MessageQuoteCard quote={quote()} onRemove={() => undefined} />);
    expect(screen.queryByRole("button", { name: /show full text/i })).toBeNull();
  });

  it("removes the quote from the composer", () => {
    const onRemove = vi.fn();
    render(<MessageQuoteCard quote={quote()} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove quote" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("scrolls to the quoted message when it is still mounted", () => {
    const target = document.createElement("div");
    target.id = "agent-msg-a1";
    const scrollIntoView = vi.fn();
    Object.defineProperty(target, "scrollIntoView", { configurable: true, value: scrollIntoView });
    document.body.append(target);

    render(<MessageQuoteCard quote={quote()} onRemove={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Go to the quoted message" }));

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(screen.queryByRole("status")).toBeNull();
    target.remove();
  });

  it("says so when the quoted message is no longer mounted", () => {
    render(<MessageQuoteCard quote={quote()} onRemove={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Go to the quoted message" }));
    expect(screen.getByRole("status").textContent).toBe("That message is not loaded in this conversation, so it cannot be shown.");
  });
});
