import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposer } from "./useComposer";
import { useRuntimeStore } from "../lib/agent-runtime";
import { apiRequest } from "../lib/client/api";
import type { ResearchStarter } from "../components/conversation/ResearchLoopControls";

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: "/workspace/w" }),
  useNavigate: () => navigateMock,
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});
vi.mock("../components/feedback/feedback-context", () => ({ useFeedback: () => ({ toast: vi.fn() }) }));
vi.mock("../lib/client/api", () => ({ apiRequest: vi.fn(async () => undefined) }));
vi.mock("../lib/files", () => ({ injectWorkspaceReferences: (message: string) => message }));

function Harness({
  onSend,
  intent,
  researchMode,
  conversationKey = null,
}: {
  onSend?: () => void;
  intent?: (text: string) => Promise<{ kind: "draft" } | { kind: "conversation"; message: string } | null>;
  researchMode?: ResearchStarter | null;
  conversationKey?: string | null;
}) {
  const composer = useComposer({
    cwd: "/w",
    conversationKey,
    selectedModel: "m",
    reviewingProject: false,
    setReviewNotice: () => undefined,
    research: {
      mode: researchMode ?? null,
      draft: null,
      intent: intent ?? (async () => null),
    },
    onSend,
  });
  return <button type="button" onClick={() => void composer.handleSend()}>send</button>;
}

beforeEach(() => {
  vi.mocked(apiRequest).mockClear();
  navigateMock.mockClear();
  useRuntimeStore.setState({
    working: false,
    activeSessionId: null,
    draft: "",
    model: "m",
    sendPrompt: vi.fn(async (): Promise<string | null> => null),
  });
});

afterEach(() => {
  cleanup();
});

describe("useComposer onSend", () => {
  it("fires onSend once right before a real message is dispatched", async () => {
    const onSend = vi.fn();
    const sendPrompt = vi.fn(async (_message: string): Promise<string | null> => null);
    useRuntimeStore.setState({ draft: "hello", sendPrompt });
    render(<Harness onSend={onSend} />);

    fireEvent.click(screen.getByRole("button", { name: "send" }));

    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledWith("hello"));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("does not fire onSend for slash commands that never dispatch a message", async () => {
    const onSend = vi.fn();
    const sendPrompt = vi.fn(async (_message: string): Promise<string | null> => null);
    useRuntimeStore.setState({ draft: "/compact", activeSessionId: "s1", sendPrompt });
    render(<Harness onSend={onSend} />);

    fireEvent.click(screen.getByRole("button", { name: "send" }));

    await vi.waitFor(() => expect(apiRequest).toHaveBeenCalled());
    expect(onSend).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("does not fire onSend for the /export slash command (opens download window only)", async () => {
    const onSend = vi.fn();
    const sendPrompt = vi.fn(async (_message: string): Promise<string | null> => null);
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      useRuntimeStore.setState({ draft: "/export jsonl", activeSessionId: "s1", sendPrompt });
      render(<Harness onSend={onSend} />);

      fireEvent.click(screen.getByRole("button", { name: "send" }));

      await vi.waitFor(() => expect(openSpy).toHaveBeenCalled());
      expect(openSpy.mock.calls[0][0]).toContain("/api/sessions/s1/export");
      expect(openSpy.mock.calls[0][0]).toContain("format=jsonl");
      expect(onSend).not.toHaveBeenCalled();
      expect(sendPrompt).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("fires onSend before sendPrompt dispatches the message", async () => {
    const order: string[] = [];
    const onSend = vi.fn(() => { order.push("onSend"); });
    const sendPrompt = vi.fn(async (_message: string): Promise<string | null> => { order.push("sendPrompt"); return null; });
    useRuntimeStore.setState({ draft: "hello", sendPrompt });
    render(<Harness onSend={onSend} />);

    fireEvent.click(screen.getByRole("button", { name: "send" }));

    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalled());
    expect(order).toEqual(["onSend", "sendPrompt"]);
  });

  it("does not fire onSend when the research intent detours into a draft", async () => {
    const onSend = vi.fn();
    const sendPrompt = vi.fn(async (_message: string): Promise<string | null> => null);
    useRuntimeStore.setState({ draft: "explore X", sendPrompt });
    render(<Harness onSend={onSend} intent={async () => ({ kind: "draft" })} researchMode={{ id: "explore", label: "Explore", prompt: "p" } as unknown as ResearchStarter} />);

    fireEvent.click(screen.getByRole("button", { name: "send" }));

    await vi.waitFor(() => expect(useRuntimeStore.getState().draft).toBe(""));
    expect(onSend).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("does not refill the composer after the user moves to another conversation", async () => {
    let fail!: (error: Error) => void;
    const sendPrompt = vi.fn(() => new Promise<string | null>((_resolve, reject) => { fail = reject; }));
    useRuntimeStore.setState({ cwd: "/w", draft: "hello", sendPrompt });
    const { rerender } = render(<Harness conversationKey={null} />);

    fireEvent.click(screen.getByRole("button", { name: "send" }));
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledWith("hello"));

    // The user opens another conversation while the send is in flight. Its clearing effect
    // empties the composer, and the late failure must not put the old draft back.
    rerender(<Harness conversationKey="s2" />);
    await vi.waitFor(() => expect(useRuntimeStore.getState().draft).toBe(""));
    await act(async () => { fail(new Error("prompt rejected")); });
    await vi.waitFor(() => expect(useRuntimeStore.getState().draft).toBe(""));
  });

  it("does not pull the user back to a session created for a send they left", async () => {
    let finish!: (value: string) => void;
    const sendPrompt = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    useRuntimeStore.setState({ cwd: "/w", draft: "hello", sendPrompt });
    const { rerender } = render(<Harness conversationKey={null} />);

    fireEvent.click(screen.getByRole("button", { name: "send" }));
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledWith("hello"));

    rerender(<Harness conversationKey="s2" />);
    await act(async () => { finish("created-session"); });
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
