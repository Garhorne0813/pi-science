/**
 * Composer review control (B-DL-1).
 *
 * `policy.auto_review` now ships off, so the composer has two states: a manual
 * "Review" button when it is off (and while the policy is still unknown), and a
 * non-busy status badge that links to the knowledge inbox when it is on.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("../../components/conversation/ModelControlMenu", () => ({
  ModelControlMenu: () => <div data-testid="model-control" />,
}));

import { LiveSessionPage } from "./LiveSessionPage";
import { WorkspaceProvider } from "../../lib/workspace-context";
import { FeedbackContext } from "../../components/feedback/feedback-context";
import { useRuntimeStore } from "../../lib/runtime-store";
import { useUiStore } from "../../lib/store";
import { queryClient } from "../../lib/query-client";
import { resetDynamicCommands } from "../../lib/slash-commands";
import i18n from "../../i18n";

const CWD = "proj";
const SESSION_ID = "s1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let autoReview = false;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input);
  if (url.startsWith("/api/project-knowledge/policy")) return jsonResponse({ auto_review: autoReview, reminder_threshold: 5 });
  if (url.startsWith("/api/settings/config")) return jsonResponse({ ok: true, available_models: [], model: "", thinking: "high" });
  if (url.includes("/commands?")) return jsonResponse({ commands: [] });
  if (url.startsWith("/api/project-memory/research-loops")) return jsonResponse({ loops: [] });
  return jsonResponse({ error: `unhandled ${(init.method || "GET").toUpperCase()} ${url}` }, 404);
});

function renderPage() {
  return render(
    <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
      <MemoryRouter initialEntries={[`/workspace/${CWD}/session/${SESSION_ID}`]}>
        <Routes>
          <Route path="/workspace/:cwd/session/:sessionId" element={<WorkspaceProvider><LiveSessionPage /></WorkspaceProvider>} />
          <Route path="/workspace/:cwd/knowledge" element={<div>knowledge inbox</div>} />
        </Routes>
      </MemoryRouter>
    </FeedbackContext.Provider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  autoReview = false;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  });
  queryClient.clear();
  resetDynamicCommands();
  useUiStore.setState({ inspectorOpen: false, inspectorTabs: [], activeInspectorIndex: 0, workspaceReferences: [] });
  useRuntimeStore.setState({
    status: "ready",
    client: null,
    sessions: [{ id: SESSION_ID, cwd: CWD, name: "Session" }],
    activeSessionId: SESSION_ID,
    cwd: CWD,
    thread: { blocks: [], index: {}, loaded: true },
    working: false,
    model: "",
    thinking: "high",
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    compactionEnabled: true,
    compactionThresholdPercent: null,
    pendingInteraction: null,
    fileRevision: 0,
    draft: "",
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    sendPrompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    createNewSession: vi.fn(async () => "s2"),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("composer review control", () => {
  it("keeps the manual Review button when auto review is off", async () => {
    renderPage();

    const button = await screen.findByRole("button", { name: "Review" });
    expect(button).toHaveAttribute("title", "Review this conversation for durable project knowledge");
    expect(screen.queryByRole("button", { name: "Auto review on" })).toBeNull();
  });

  it("replaces the manual button with a badge that opens the knowledge inbox when auto review is on", async () => {
    autoReview = true;
    renderPage();

    const badge = await screen.findByRole("button", { name: "Auto review on" });
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    expect(badge).not.toBeDisabled();

    fireEvent.click(badge);
    await waitFor(() => expect(screen.getByText("knowledge inbox")).toBeInTheDocument());
  });
});
