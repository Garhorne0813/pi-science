import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposer } from "./useComposer";
import { useRuntimeStore } from "../lib/agent-runtime";
import { apiRequest } from "../lib/client/api";
import { useUiStore } from "../lib/ui";
import { buildMessageQuote, useMessageQuoteStore, type MessageQuote } from "../lib/conversation/message-quote";

vi.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: "/workspace/w" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});
vi.mock("../components/feedback/feedback-context", () => ({ useFeedback: () => ({ toast: vi.fn() }) }));
vi.mock("../lib/client/api", () => ({ apiRequest: vi.fn(async () => undefined) }));
vi.mock("../lib/files", () => ({ injectWorkspaceReferences: (message: string) => message }));

function Harness() {
  const composer = useComposer({
    cwd: "/w",
    conversationKey: "s1",
    selectedModel: "m",
    reviewingProject: false,
    setReviewNotice: () => undefined,
    research: { mode: null, setMode: () => undefined },
  });
  return <button type="button" onClick={() => void composer.handleSend().catch(() => undefined)}>send</button>;
}

/** A pending quote in the conversation the runtime shows. */
function fileQuote(overrides: Partial<MessageQuote> = {}): MessageQuote {
  const built = buildMessageQuote({ source: { workspaceCwd: "/w", sessionId: "s1", blockId: "a1", role: "agent" }, messageText: "Read the log twice, then report.", selection: "then report." });
  if (!built) throw new Error("expected a quote");
  const quote = { ...built, ...overrides };
  useMessageQuoteStore.setState({ quotes: { "/w\u0000s1": quote } });
  return quote;
}

beforeEach(() => {
  vi.mocked(apiRequest).mockClear();
  useUiStore.setState({ workspaceReferences: [] });
  useMessageQuoteStore.setState({ quotes: {} });
  useRuntimeStore.setState({
    cwd: "/w",
    working: false,
    activeSessionId: "s1",
    draft: "",
    model: "m",
    sendPrompt: vi.fn(async (): Promise<string | null> => "s1"),
  });
});

afterEach(() => { cleanup(); });

describe("useComposer with a pending quote", () => {
  it("sends the full quoted text with its source role and the user's question", async () => {
    fileQuote();
    useRuntimeStore.setState({ draft: "why twice?" });
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "send" }));

    await waitFor(() => expect(useRuntimeStore.getState().sendPrompt).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(useRuntimeStore.getState().sendPrompt).mock.calls[0]![0];
    expect(sent).toBe('<quoted_message role="agent" kind="selection">\nthen report.\n</quoted_message>\n\nwhy twice?');
  });

  it("sends a whole user message as a whole-message quote", async () => {
    const built = buildMessageQuote({ source: { workspaceCwd: "/w", sessionId: "s1", blockId: "u7", role: "user" }, messageText: "Read the log" });
    if (!built) throw new Error("expected a quote");
    useMessageQuoteStore.setState({ quotes: { "/w\u0000s1": built } });
    useRuntimeStore.setState({ draft: "and then?" });
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "send" }));

    await waitFor(() => expect(useRuntimeStore.getState().sendPrompt).toHaveBeenCalledTimes(1));
    expect(vi.mocked(useRuntimeStore.getState().sendPrompt).mock.calls[0]![0])
      .toBe('<quoted_message role="user" kind="message">\nRead the log\n</quoted_message>\n\nand then?');
  });

  it("clears the quote once the send is accepted", async () => {
    fileQuote();
    useRuntimeStore.setState({ draft: "why twice?" });
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "send" }));

    await waitFor(() => expect(useMessageQuoteStore.getState().quotes).toEqual({}));
  });

  it("sends a quote with no question of its own", async () => {
    fileQuote();
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "send" }));

    await waitFor(() => expect(useRuntimeStore.getState().sendPrompt).toHaveBeenCalledTimes(1));
    expect(vi.mocked(useRuntimeStore.getState().sendPrompt).mock.calls[0]![0])
      .toBe('<quoted_message role="agent" kind="selection">\nthen report.\n</quoted_message>');
  });

  it("restores the quote and the draft when the send fails", async () => {
    const quote = fileQuote();
    useRuntimeStore.setState({ draft: "why twice?", sendPrompt: vi.fn(async () => { throw new Error("offline"); }) });
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "send" }));

    await waitFor(() => expect(useRuntimeStore.getState().draft).toBe("why twice?"));
    expect(useMessageQuoteStore.getState().quotes).toEqual({ "/w\u0000s1": quote });
  });

  it("does not let a slash command swallow the quote", async () => {
    fileQuote();
    useRuntimeStore.setState({ draft: "/compact" });
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "send" }));

    await waitFor(() => expect(useRuntimeStore.getState().sendPrompt).toHaveBeenCalledTimes(1));
    expect(apiRequest).not.toHaveBeenCalled();
    expect(vi.mocked(useRuntimeStore.getState().sendPrompt).mock.calls[0]![0]).toContain("</quoted_message>\n\n/compact");
  });

  it("keeps a quote filed for another conversation out of this send", async () => {
    const built = buildMessageQuote({ source: { workspaceCwd: "/w", sessionId: "other", blockId: "a9", role: "agent" }, messageText: "Elsewhere" });
    if (!built) throw new Error("expected a quote");
    useMessageQuoteStore.setState({ quotes: { "/w\u0000other": built } });
    useRuntimeStore.setState({ draft: "hello" });
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "send" }));

    await waitFor(() => expect(useRuntimeStore.getState().sendPrompt).toHaveBeenCalledTimes(1));
    expect(vi.mocked(useRuntimeStore.getState().sendPrompt).mock.calls[0]![0]).toBe("hello");
    expect(Object.keys(useMessageQuoteStore.getState().quotes)).toEqual(["/w\u0000other"]);
  });

  it("keeps the draft when the user writes after sending", async () => {
    fileQuote();
    useRuntimeStore.setState({ draft: "why twice?" });
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "send" }));
    await waitFor(() => expect(useRuntimeStore.getState().sendPrompt).toHaveBeenCalledTimes(1));

    act(() => { useRuntimeStore.setState({ draft: "a new question" }); });
    expect(useMessageQuoteStore.getState().quotes).toEqual({});
  });
});
