import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposer } from "./useComposer";
import { useRuntimeStore } from "../lib/agent-runtime";
import { apiRequest } from "../lib/client/api";

vi.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: "/workspace/w", state: { initialDraft: "initial draft" } }),
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
    selectedModel: "m",
    reviewingProject: false,
    setReviewNotice: () => undefined,
    research: { mode: null, draft: null, intent: async () => null },
    onSend: undefined,
  });
  return <button type="button" onClick={() => void composer.handleSend()}>send</button>;
}

beforeEach(() => {
  vi.mocked(apiRequest).mockClear();
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

describe("useComposer initial draft", () => {
  it("pre-fills the composer draft from location state", async () => {
    render(<Harness />);
    await waitFor(() => expect(useRuntimeStore.getState().draft).toBe("initial draft"));
  });
});