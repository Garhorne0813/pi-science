/**
 * Characterization tests for LiveSessionPage.
 *
 * These lock in CURRENT observable behavior of the five highest-risk composer /
 * turn-effect behaviors so the planned LiveSessionPage split can be verified as
 * behavior-preserving. They deliberately do NOT assert what the behavior *should*
 * be — if one of these looks wrong, change the component first and then the test.
 *
 * Covered:
 *   a. composer send-failure restore (and the skip-restore-when-user-retyped path)
 *   b. IME composition Enter guard (including the compositionend setTimeout(0))
 *   c. turn-completion effects (auto-preview + follow-up suggestions state machine)
 *   d. model/thinking optimistic update and rollback on save failure
 *   e. slash-command dispatcher (/compact, /export, unknown falls through to send)
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType, ReactNode, Ref } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { VirtuosoHandle } from "react-virtuoso";

const { virtuosoProps } = vi.hoisted(() => ({ virtuosoProps: [] as Array<Record<string, unknown>> }));
vi.mock("react-virtuoso", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-virtuoso")>();
  const React = await import("react");
  const Virtuoso = React.forwardRef((props: Record<string, unknown>, ref) => {
    virtuosoProps.push(props);
    return React.createElement(actual.Virtuoso, { ...props, ref: ref as Ref<VirtuosoHandle> });
  });
  return { ...actual, Virtuoso };
});

vi.mock("../../components/conversation/ModelControlMenu", () => ({
  // The real menu is a Radix dropdown; the behaviors under test are the page's
  // handlers, so the mock only exposes the props they are driven through.
  ModelControlMenu: (props: {
    models: Array<{ id: string }>;
    selectedModel: string;
    thinking: string;
    disabled?: boolean;
    onModelChange: (model: string) => void;
    onThinkingChange: (level: string) => void;
  }) => (
    <div data-testid="model-control" data-model={props.selectedModel} data-thinking={props.thinking} data-disabled={String(!!props.disabled)}>
      {props.models.map((model) => (
        <button key={model.id} type="button" onClick={() => props.onModelChange(model.id)}>{`pick ${model.id}`}</button>
      ))}
      <button type="button" onClick={() => props.onThinkingChange("low")}>pick thinking low</button>
    </div>
  ),
}));

vi.mock("../../components/conversation/SessionExecutionButton", () => ({
  SessionExecutionButton: ({ active, onToggle }: { active: boolean; onToggle: () => void }) => (
    <button type="button" aria-label="Session executions" aria-pressed={active} onClick={onToggle} />
  ),
}));

vi.mock("./RunsPage", () => ({
  RunsPage: () => <div>Execution ledger</div>,
}));

import { LiveSessionPage } from "./LiveSessionPage";
import { WorkspaceProvider } from "../../lib/workspace";
import { FeedbackContext } from "../../components/feedback/feedback-context";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { useUiStore } from "../../lib/ui";
import { queryClient } from "../../lib/client/query-client";
import { resetDynamicCommands } from "../../lib/conversation";
import type { PendingInteraction, PendingQuestionnaire } from "../../lib/agent-runtime";
import i18n from "../../i18n";
import type { ThreadBlock } from "../../types/thread";

const CWD = "proj";
const SESSION_ID = "s1";

const MODELS = [
  { id: "prov/m1", provider: "prov", model: "m1", label: "M1", thinking_levels: ["low", "high"] },
  { id: "prov/m2", provider: "prov", model: "m2", label: "M2", thinking_levels: ["low", "medium"] },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Per-test fetch overrides, consulted before the defaults. */
let overrides: Array<(url: string, init: RequestInit) => Promise<Response> | null> = [];

function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  if (url.startsWith("/api/settings/config")) {
    return Promise.resolve(jsonResponse({ ok: true, available_models: MODELS, model: "prov/m1", thinking: "high" }));
  }
  if (url.startsWith("/api/settings/subagents/discovery")) {
    return Promise.resolve(jsonResponse({ agents: [
      { name: "reviewer", description: "Review work", source: "builtin" },
      { name: "scout", description: "Gather context", source: "builtin" },
    ] }));
  }
  if (url.startsWith("/api/sessions/s1/messages/index")) {
    return Promise.resolve(jsonResponse({ messages: [], snapshot_version: "" }));
  }
  if (url.startsWith("/api/sessions/s1/stats")) {
    return Promise.resolve(jsonResponse({ ok: true, stats: {
      userMessages: 2,
      assistantMessages: 2,
      toolCalls: 3,
      toolResults: 3,
      totalMessages: 7,
      tokens: { input: 1000, output: 500, cacheRead: 800, cacheWrite: 0, total: 1500 },
      llmMs: 3000,
      toolMs: 1000,
      ttftMs: 200,
      ttftSteps: 2,
      decodeMs: 2500,
    } }));
  }
  if (url.includes("/commands?")) return Promise.resolve(jsonResponse({ commands: [] }));
  if (url.startsWith("/api/project-memory/research-loops")) return Promise.resolve(jsonResponse({ loops: [] }));
  if (method === "PUT" && url.startsWith("/api/settings/model")) {
    return Promise.resolve(jsonResponse({ ok: true, model: "prov/m2", thinking: "medium" }));
  }
  if (method === "POST" && url.includes("/compact")) return Promise.resolve(jsonResponse({ ok: true }));
  return Promise.resolve(jsonResponse({ error: `unhandled ${method} ${url}` }, 404));
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input);
  for (const override of overrides) {
    const response = override(url, init);
    if (response) return response;
  }
  return defaultFetch(url, init);
});

function agentBlock(id: string, text: string): ThreadBlock {
  return { kind: "agent", id, parts: [{ id: `${id}-p0`, text }] };
}

function userBlock(id: string, text: string): ThreadBlock {
  return { kind: "user", id, text, timestamp: new Date().toISOString() };
}

function toolBlock(callId: string): ThreadBlock {
  return { kind: "tool", id: `tool-${callId}`, callId, tool: "bash", status: "done", output: "ok" };
}

function publishedArtifactBlock(path: string): ThreadBlock {
  return {
    kind: "status-line",
    id: `artifact-${path}`,
    text: `Published artifact: ${path}`,
    level: "done",
    path,
  };
}

function turnArtifactSummaryBlock(agentId: string, path: string): ThreadBlock {
  return {
    kind: "artifact-summary",
    id: `turn-artifacts-${agentId}`,
    turnId: `turn-${agentId}`,
    assistantMessageId: agentId,
    artifacts: [{ path, kind: "image", mime: "image/png", size: 10 }],
  };
}

/** IntersectionObserver stub that captures its callback so tests can drive
 *  the rail highlight logic manually (jsdom has no IO implementation). */
class IOStub {
  static instances: IOStub[] = [];
  cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    IOStub.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function textarea(): HTMLTextAreaElement {
  const element = document.querySelector("textarea");
  if (!element) throw new Error("composer textarea not mounted");
  return element;
}

function sendButton(): HTMLElement {
  return screen.getByLabelText("Send message");
}

function renderPage(search = "") {
  return render(
    <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
      <MemoryRouter initialEntries={[`/workspace/${CWD}/session/${SESSION_ID}${search}`]}>
        <Routes>
          {/* The app mounts WorkspaceProvider around the route tree (app/router.tsx). */}
          <Route path="/workspace/:cwd/session/:sessionId" element={<WorkspaceProvider><LiveSessionPage /></WorkspaceProvider>} />
        </Routes>
      </MemoryRouter>
    </FeedbackContext.Provider>,
  );
}

function renderWorkspaceLanding() {
  return render(
    <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
      <MemoryRouter initialEntries={[`/workspace/${CWD}`]}>
        <Routes>
          <Route path="/workspace/:cwd" element={<WorkspaceProvider><LiveSessionPage /></WorkspaceProvider>} />
        </Routes>
      </MemoryRouter>
    </FeedbackContext.Provider>,
  );
}

/** Render and wait until the model list has loaded (handleSend no-ops without it). */
async function renderReady() {
  const view = renderPage();
  await screen.findByTestId("model-control");
  return view;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  overrides = [];
  virtuosoProps.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  IOStub.instances = [];
  vi.stubGlobal("IntersectionObserver", IOStub);
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollBy = vi.fn();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  }));
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  });
  queryClient.clear();
  resetDynamicCommands();
  useUiStore.setState({ inspectorOpen: false, inspectorData: null, workspaceReferences: [], settingsOpen: false, settingsScope: null, });
  useRuntimeStore.setState({
    status: "ready",
    client: null,
    sessions: [{ id: SESSION_ID, cwd: CWD, name: "Session" }],
    activeSessionId: SESSION_ID,
    cwd: CWD,
    thread: { blocks: [], index: {}, loaded: true },
    historyCursor: null,
    historyHasMore: false,
    historyLoading: false,
    historySnapshotVersion: "",
    working: false,
    model: "prov/m1",
    thinking: "high",
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    compactionEnabled: true,
    compactionThresholdPercent: null,
    sessionStats: null,
    pendingInteraction: null,
    pendingQuestionnaire: null,
    fileRevision: 0,
    draft: "",
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    sendPrompt: vi.fn(async (): Promise<string | null> => null),
    abort: vi.fn(async () => undefined),
    createNewSession: vi.fn(async () => "s2"),
    // Session-local model changes go through the runtime store action; the
    // default stub mirrors the real action's success path (apply model/thinking
    // to the store, keep the session id) without needing a Pi client.
    setModel: vi.fn(async (model: string, thinking?: string) => {
      useRuntimeStore.setState({ model, thinking: thinking ?? null });
      return SESSION_ID;
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});


describe("composer send-failure restore", () => {
  it("uses the compact conversation header height", async () => {
    await renderReady();
    expect(screen.getByRole("banner")).toHaveClass("h-11");
  });

  it("keeps the persisted title when a paged tail has no user block", async () => {
    useRuntimeStore.setState({
      sessions: [{ id: SESSION_ID, cwd: CWD, name: "Persisted experiment title" }],
      thread: { blocks: [agentBlock("agent-tail", "tail output")], index: { "agent-tail": 0 }, loaded: true },
    });
    await renderReady();

    expect(screen.getByRole("heading", { name: "Persisted experiment title" })).toBeInTheDocument();
  });

  it("uses compact spacing for the composer toolbar", async () => {
    await renderReady();
    const toolbar = screen.getByLabelText("Send message").parentElement?.parentElement;
    expect(toolbar).toHaveClass("pb-1");
  });

  it("loads the configured model and sends from a workspace without an active session", async () => {
    const sendPrompt = vi.fn(async (_message: string): Promise<string | null> => null);
    useRuntimeStore.setState({ sessions: [], activeSessionId: null, model: "", sendPrompt });

    renderWorkspaceLanding();
    await screen.findByTestId("model-control");
    expect(screen.getByTestId("model-control")).toHaveAttribute("data-model", "prov/m1");

    act(() => { useRuntimeStore.getState().setDraft("start a new conversation"); });
    fireEvent.click(sendButton());

    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith("start a new conversation"));
  });

  it("restores the draft and workspace references when sendPrompt rejects", async () => {
    const sendPrompt = vi.fn(async (_message: string) => { throw new Error("network down"); });
    useRuntimeStore.setState({ sendPrompt });
    await renderReady();

    act(() => {
      useUiStore.getState().addWorkspaceReference({ cwd: CWD, path: "data/a.csv", name: "a.csv", isDir: false });
      useRuntimeStore.getState().setDraft("hello");
    });
    fireEvent.click(sendButton());

    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    // The reference block is injected into the sent message, not kept in the draft.
    expect(sendPrompt.mock.calls[0][0]).toContain("<workspace_references>");
    expect(sendPrompt.mock.calls[0][0]).toContain("hello");

    await waitFor(() => expect(useRuntimeStore.getState().draft).toBe("hello"));
    expect(useUiStore.getState().workspaceReferences).toEqual([
      { cwd: CWD, path: "data/a.csv", name: "a.csv", isDir: false },
    ]);
  });

  it("does not overwrite a draft the user typed while the failing send was in flight", async () => {
    let rejectSend: (error: Error) => void = () => undefined;
    const pending = new Promise<void>((_resolve, reject) => { rejectSend = reject; });
    const sendPrompt = vi.fn((_message: string): Promise<string | null> => pending as unknown as Promise<string | null>);
    useRuntimeStore.setState({ sendPrompt });
    await renderReady();

    act(() => {
      useUiStore.getState().addWorkspaceReference({ cwd: CWD, path: "data/a.csv", name: "a.csv", isDir: false });
      useRuntimeStore.getState().setDraft("first attempt");
    });
    fireEvent.click(sendButton());

    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    expect(useRuntimeStore.getState().draft).toBe("");
    expect(useUiStore.getState().workspaceReferences).toEqual([]);

    act(() => { useRuntimeStore.getState().setDraft("typed while sending"); });
    await act(async () => {
      rejectSend(new Error("network down"));
      await pending.catch(() => undefined);
    });

    // References are always re-added; the draft is only restored when empty.
    await waitFor(() => expect(useUiStore.getState().workspaceReferences).toHaveLength(1));
    expect(useRuntimeStore.getState().draft).toBe("typed while sending");
  });
});

describe("conversation research workflows", () => {
  it("sends compare as a structured conversation task instead of creating a loop", async () => {
    const sendPrompt = vi.fn(async (_message: string): Promise<string | null> => null);
    useRuntimeStore.setState({ sendPrompt });
    overrides.push((url, init) => {
      if ((init.method || "GET").toUpperCase() !== "POST" || !url.startsWith("/api/project-memory/research-loop-intents")) return null;
      expect(JSON.parse(String(init.body))).toEqual({ mode: "compare", objective: "Compare method A and method B" });
      return Promise.resolve(jsonResponse({
        requires_confirmation: false,
        missing_fields: [],
        draft: {
          task_type: "compare", execution_kind: "conversation", title: "Compare method A and method B", objective: "Compare method A and method B",
          metric: null, direction: "maximize", budget: { max_candidates: 6, max_wall_seconds: 7200, max_parallel: 1 },
          success_criterion: null, plan_steps: [], stop_conditions: { target_metrics: {}, patience: 3, min_improvement: 0 }, instructions: [],
          conversation_prompt: "[Workflow: compare]\nObjective: Compare method A and method B\n\nRequired process:\n1. Return a comparison table.",
        },
      }));
    });

    useUiStore.getState().addWorkspaceReference({ cwd: CWD, path: "methods/results.csv", name: "results.csv", isDir: false });
    renderWorkspaceLanding();
    await screen.findByTestId("model-control");
    fireEvent.click(screen.getByRole("button", { name: "Compare approaches" }));
    act(() => { useRuntimeStore.getState().setDraft("Compare method A and method B"); });
    fireEvent.click(sendButton());

    await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith(expect.stringContaining("[Workflow: compare]")));
    expect(sendPrompt.mock.calls[0][0]).toContain("methods/results.csv");
    expect(screen.queryByText("Confirm Compare approaches")).toBeNull();
  });

  it("hides workflow starters after a conversation has already begun", async () => {
    useRuntimeStore.setState({
      thread: {
        blocks: [{ kind: "user", id: "u1", text: "Earlier analysis", timestamp: new Date().toISOString() }],
        index: { u1: 0 },
        loaded: true,
      },
    });

    await renderReady();

    expect(screen.queryByRole("button", { name: "Optimize" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reproduce experiment" })).toBeNull();
  });

  it("turns optimize into an editable loop draft and infers a deterministic metric", async () => {
    const sendPrompt = vi.fn(async (_message: string): Promise<string | null> => null);
    useRuntimeStore.setState({ sendPrompt });
    overrides.push((url, init) => {
      if ((init.method || "GET").toUpperCase() !== "POST" || !url.startsWith("/api/project-memory/research-loop-intents")) return null;
      return Promise.resolve(jsonResponse({
        requires_confirmation: true,
        missing_fields: [],
        draft: {
          task_type: "optimize", execution_kind: "iterative", title: "Minimize model latency", objective: "Minimize model latency",
          metric: "latency", direction: "minimize", budget: { max_candidates: 10, max_wall_seconds: 7200, max_parallel: 1 },
          success_criterion: "Reduce latency with reproducible measurements while preserving required checks.",
          plan_steps: ["Establish a reproducible baseline.", "Measure one change per round."],
          stop_conditions: { target_metrics: {}, patience: 3, min_improvement: 0 }, instructions: [], conversation_prompt: null,
        },
      }));
    });

    renderWorkspaceLanding();
    await screen.findByTestId("model-control");
    fireEvent.click(screen.getByRole("button", { name: "Optimize" }));
    act(() => { useRuntimeStore.getState().setDraft("Minimize model latency"); });
    fireEvent.click(sendButton());

    expect(await screen.findByText("Confirm Optimize")).toBeInTheDocument();
    expect(screen.getByText("Reduce latency with reproducible measurements while preserving required checks.")).toBeInTheDocument();
    expect(screen.getByText("Establish a reproducible baseline.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Metric")).toBeNull();
    expect(screen.getByRole("button", { name: "Create and start" })).toBeEnabled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});


describe("IME composition Enter guard", () => {
  it("suppresses Enter during composition and sends only after compositionend settles", async () => {
    const sendPrompt = vi.fn(async (_message: string): Promise<string | null> => null);
    useRuntimeStore.setState({ sendPrompt });
    await renderReady();
    act(() => { useRuntimeStore.getState().setDraft("你好"); });
    const input = textarea();

    // 1. Browser-reported composition (nativeEvent.isComposing).
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(sendPrompt).not.toHaveBeenCalled();

    // 2. Our own composingRef, for browsers that do not set isComposing.
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sendPrompt).not.toHaveBeenCalled();

    // 3. compositionend clears the ref on a setTimeout(0), so the Enter that
    //    the IME emits in the same tick is still suppressed.
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sendPrompt).not.toHaveBeenCalled();

    // 4. After that timeout, Enter sends.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    expect(sendPrompt.mock.calls[0][0]).toBe("你好");
  });

  it("does not send on Shift+Enter", async () => {
    const sendPrompt = vi.fn(async (_message: string): Promise<string | null> => null);
    useRuntimeStore.setState({ sendPrompt });
    await renderReady();
    act(() => { useRuntimeStore.getState().setDraft("multi"); });

    fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true });
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});


describe("turn-completion effects", () => {
  it("does not auto-open the inspector or set suggestions for replayed history", async () => {
    const openInspector = vi.fn();
    useUiStore.setState({ openInspector });
    useRuntimeStore.setState({
      thread: {
        blocks: [agentBlock("a1", "Saved outputs/plot.png\n<!--suggest: try again | plot residuals-->")],
        index: { a1: 0 },
        loaded: true,
      },
    });

    await renderReady();
    // `working` never flips for history replay, so the effect returns early.
    expect(openInspector).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Suggested follow-ups")).toBeNull();
  });

  it("opens the inspector once per completed turn and never re-fires for the same block", async () => {
    const openInspector = vi.fn();
    useUiStore.setState({ openInspector });
    await renderReady();

    act(() => { useRuntimeStore.setState({ working: true }); });
    expect(openInspector).not.toHaveBeenCalled();

    act(() => {
      useRuntimeStore.setState({
        working: false,
        thread: {
          blocks: [
            agentBlock("a1", "Saved outputs/plot.png\n<!--suggest: plot residuals-->"),
            publishedArtifactBlock("outputs/plot.png"),
          ],
          index: { a1: 0, "artifact-outputs/plot.png": 1 },
          loaded: true,
        },
      });
    });

    await waitFor(() => expect(openInspector).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(openInspector.mock.calls[0][0])).toContain("outputs/plot.png");
    expect(screen.getByLabelText("Suggested follow-ups")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "plot residuals" })).toBeInTheDocument();

    // A second turn that produces no new agent block must not re-open it.
    act(() => { useRuntimeStore.setState({ working: true }); });
    expect(screen.queryByLabelText("Suggested follow-ups")).toBeNull();
    act(() => { useRuntimeStore.setState({ working: false }); });
    await waitFor(() => expect(openInspector).toHaveBeenCalledTimes(1));
  });

  it("fills the composer draft with a clicked suggestion instead of sending it", async () => {
    const sendPrompt = vi.fn(async (_message: string): Promise<string | null> => null);
    useRuntimeStore.setState({ sendPrompt });
    await renderReady();

    act(() => { useRuntimeStore.setState({ working: true }); });
    act(() => {
      useRuntimeStore.setState({
        working: false,
        thread: {
          blocks: [agentBlock("a1", "Saved outputs/plot.png\n<!--suggest: plot residuals-->")],
          index: { a1: 0 },
          loaded: true,
        },
      });
    });

    const suggestion = await screen.findByRole("button", { name: "plot residuals" });
    fireEvent.click(suggestion);

    // Draft filled, nothing dispatched.
    await waitFor(() => expect(useRuntimeStore.getState().draft).toBe("plot residuals"));
    expect(sendPrompt).not.toHaveBeenCalled();
    // Composer textarea gains focus after picking a suggestion.
    expect(document.activeElement).toBe(textarea());
    // Chips disappear after picking one.
    expect(screen.queryByLabelText("Suggested follow-ups")).toBeNull();
  });

  it("renders suggestions directly after the agent message and clears them when the conversation continues", async () => {
    const sendPrompt = vi.fn(async (_message: string): Promise<string | null> => null);
    useRuntimeStore.setState({ sendPrompt });
    await renderReady();

    act(() => { useRuntimeStore.setState({ working: true }); });
    act(() => {
      useRuntimeStore.setState({
        working: false,
        thread: {
          blocks: [agentBlock("a1", "Answer body.\n<!--suggest: Continue analysis-->")],
          index: { a1: 0 },
          loaded: true,
        },
      });
    });

    const chips = await screen.findByLabelText("Suggested follow-ups");
    expect(chips.previousElementSibling).not.toBeNull();
    expect(chips.parentElement?.textContent).toContain("Answer body.");

    act(() => { useRuntimeStore.getState().setDraft("My next question"); });
    fireEvent.keyDown(textarea(), { key: "Enter" });
    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Suggested follow-ups")).toBeNull();
  });

  it("renders generated-file cards before suggestions beneath the agent message", async () => {
    await renderReady();

    act(() => { useRuntimeStore.setState({ working: true }); });
    act(() => {
      useRuntimeStore.setState({
        working: false,
        thread: {
          blocks: [
            agentBlock("a1", "Created a plot.\n<!--suggest: Analyze the plot-->"),
            turnArtifactSummaryBlock("a1", "outputs/plot.png"),
          ],
          index: { a1: 0, "turn-artifacts-a1": 1 },
          loaded: true,
        },
      });
    });

    const generatedFiles = await screen.findByLabelText("Generated files");
    const suggestions = await screen.findByLabelText("Suggested follow-ups");
    expect(generatedFiles.compareDocumentPosition(suggestions) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });
});


describe("stable Virtuoso footer", () => {
  it("uses the wired Footer, keeps its identity stable, and renders updated context", async () => {
    type FooterContext = {
      renderInteractionPrompt: () => ReactNode;
      working: boolean;
      pendingInteraction: PendingInteraction | null;
    };
    type VirtuosoProps = {
      context?: FooterContext;
      components?: { Footer?: ComponentType<{ context: FooterContext }> };
    };
    const latestProps = () => virtuosoProps.at(-1) as VirtuosoProps | undefined;

    useRuntimeStore.setState({
      thread: { blocks: [userBlock("u1", "Earlier question")], index: { u1: 0 }, loaded: true },
    });
    await renderReady();
    await waitFor(() => expect(latestProps()?.components?.Footer).toBeDefined());

    const initial = latestProps();
    if (!initial?.components?.Footer || !initial.context) throw new Error("Virtuoso Footer was not wired");
    const Footer = initial.components.Footer;
    const footerView = render(<Footer context={initial.context} />);

    act(() => { useRuntimeStore.setState({ working: true }); });
    await waitFor(() => expect(latestProps()?.context?.working).toBe(true));
    const workingProps = latestProps();
    expect(workingProps?.components?.Footer).toBe(Footer);
    if (!workingProps?.context) throw new Error("updated Virtuoso context was not captured");
    footerView.rerender(<Footer context={workingProps.context} />);
    expect(footerView.container).toHaveTextContent("Thinking");
    expect(footerView.container).toHaveTextContent("Analyzing the request");

    act(() => { useRuntimeStore.setState({
      thread: { blocks: [
        userBlock("u1", "Earlier question"),
        { kind: "agent", id: "process", parts: [{ id: "p1", text: "Checking the request." }] },
        { kind: "agent", id: "answer", partial: true, parts: [{ id: "p2", text: "Here is the answer." }] },
      ], index: {}, loaded: true },
    }); });
    expect(footerView.container).not.toHaveTextContent("Thinking");
    act(() => { useRuntimeStore.setState({
      thread: { blocks: [...useRuntimeStore.getState().thread.blocks, userBlock("u2", "Next question")], index: {}, loaded: true },
    }); });
    expect(footerView.container).toHaveTextContent("Thinking");

    const interaction: PendingInteraction = {
      requestId: "questionnaire-request",
      method: "input",
      title: "Questionnaire",
      questionnaire: true,
      toolCallId: "questionnaire-tool",
    };
    const questionnaire: PendingQuestionnaire = {
      toolCallId: "questionnaire-tool",
      questions: [{
        question: "Which mode should we use?",
        header: "Mode",
        multiSelect: false,
        options: [
          { label: "Fast", description: "Run quickly." },
          { label: "Careful", description: "Run with extra checks." },
        ],
      }],
    };
    act(() => { useRuntimeStore.setState({ pendingInteraction: interaction, pendingQuestionnaire: questionnaire }); });
    await waitFor(() => expect(latestProps()?.context?.pendingInteraction).toBe(interaction));
    const questionnaireProps = latestProps();
    expect(questionnaireProps?.components?.Footer).toBe(Footer);
    expect(questionnaireProps?.context?.renderInteractionPrompt).not.toBe(initial.context.renderInteractionPrompt);
    if (!questionnaireProps?.context) throw new Error("questionnaire Virtuoso context was not captured");
    footerView.rerender(<Footer context={questionnaireProps.context} />);
    expect(footerView.container).toHaveTextContent("Which mode should we use?");

    const option = within(footerView.container).getByRole("button", { name: /Fast/ });
    fireEvent.click(option);
    expect(option).toHaveAttribute("aria-pressed", "true");

    act(() => { useRuntimeStore.setState({ working: false }); });
    await waitFor(() => expect(latestProps()?.context?.working).toBe(false));
    const settledProps = latestProps();
    expect(settledProps?.components?.Footer).toBe(Footer);
    if (!settledProps?.context) throw new Error("settled Virtuoso context was not captured");
    footerView.rerender(<Footer context={settledProps.context} />);
    const selectedOption = within(footerView.container).getAllByRole("button", { name: /Fast/ }).find((button) => button.hasAttribute("aria-pressed"));
    expect(selectedOption).toHaveAttribute("aria-pressed", "true");
    expect(within(footerView.container).getByRole("region", { name: "Answer a few questions" })).toBeInTheDocument();
  });
});

describe("model change optimistic rollback", () => {
  it("rolls back both model and thinking when the settings save fails", async () => {
    let rejectSave: (error: Error) => void = () => undefined;
    const savePending = new Promise<Response>((_resolve, reject) => { rejectSave = reject; });
    overrides.push((url, init) => (
      (init.method || "GET").toUpperCase() === "PUT" && url.startsWith("/api/settings/model") ? savePending : null
    ));
    await renderReady();

    const control = screen.getByTestId("model-control");
    expect(control).toHaveAttribute("data-model", "prov/m1");
    expect(control).toHaveAttribute("data-thinking", "high");

    fireEvent.click(screen.getByRole("button", { name: "pick prov/m2" }));

    // Optimistic: model switches immediately and thinking is clamped to what m2 supports.
    await waitFor(() => expect(screen.getByTestId("model-control")).toHaveAttribute("data-model", "prov/m2"));
    expect(screen.getByTestId("model-control")).toHaveAttribute("data-thinking", "medium");

    await act(async () => {
      rejectSave(new Error("settings unavailable"));
      await savePending.catch(() => undefined);
    });

    await waitFor(() => expect(screen.getByTestId("model-control")).toHaveAttribute("data-model", "prov/m1"));
    expect(screen.getByTestId("model-control")).toHaveAttribute("data-thinking", "high");
    expect(screen.getByTitle("settings unavailable")).toBeInTheDocument();
  });

  it("rolls back a failed thinking-level change", async () => {
    overrides.push((url, init) => (
      (init.method || "GET").toUpperCase() === "PUT" && url.startsWith("/api/settings/model")
        ? Promise.resolve(jsonResponse({ error: "thinking rejected" }, 500))
        : null
    ));
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: "pick thinking low" }));

    await waitFor(() => expect(screen.getByTitle("thinking rejected")).toBeInTheDocument());
    expect(screen.getByTestId("model-control")).toHaveAttribute("data-thinking", "high");
    expect(screen.getByTestId("model-control")).toHaveAttribute("data-model", "prov/m1");
  });
});


describe("slash-command dispatcher", () => {
  it("keeps the slash draft when Escape closes the command menu", async () => {
    await renderReady();
    act(() => { useRuntimeStore.getState().setDraft("/"); });

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(textarea()).toHaveValue("/");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("clears the composer draft when the conversation changes", async () => {
    await renderReady();
    act(() => { useRuntimeStore.getState().setDraft("/skill:review"); });
    expect(textarea()).toHaveValue("/skill:review");

    act(() => { useRuntimeStore.setState({ activeSessionId: "s2" }); });

    await waitFor(() => expect(textarea()).toHaveValue(""));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("/compact posts to the compact endpoint and reports it without sending a prompt", async () => {
    const sendPrompt = vi.fn(async (_message: string): Promise<string | null> => null);
    useRuntimeStore.setState({ sendPrompt });
    await renderReady();
    act(() => { useRuntimeStore.getState().setDraft("/compact"); });

    fireEvent.click(sendButton());

    await waitFor(() => expect(screen.getByText("Session compacted")).toBeInTheDocument());
    const compactCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/compact"));
    expect(compactCall).toBeDefined();
    if (!compactCall) throw new Error("compact request was not sent");
    expect(String(compactCall[0])).toBe(`/api/sessions/${SESSION_ID}/compact?cwd=${CWD}`);
    expect((compactCall[1] as RequestInit).method).toBe("POST");
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().draft).toBe("");
  });

  it("/export opens the selected session format without sending a prompt", async () => {
    const sendPrompt = vi.fn(async (_message: string): Promise<string | null> => null);
    useRuntimeStore.setState({ sendPrompt });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await renderReady();
    act(() => { useRuntimeStore.getState().setDraft("/export jsonl"); });

    fireEvent.click(sendButton());

    await waitFor(() => expect(open).toHaveBeenCalledWith(
      `/api/sessions/${SESSION_ID}/export?cwd=${CWD}&format=jsonl`,
      "_blank",
      "noopener,noreferrer",
    ));
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().draft).toBe("");
    open.mockRestore();
  });

  it("an unknown slash command falls through to a normal send", async () => {
    const sendPrompt = vi.fn(async (_message: string): Promise<string | null> => null);
    useRuntimeStore.setState({ sendPrompt });
    await renderReady();
    act(() => { useRuntimeStore.getState().setDraft("/xyz do a thing"); });

    fireEvent.click(sendButton());

    await waitFor(() => expect(sendPrompt).toHaveBeenCalledTimes(1));
    expect(sendPrompt.mock.calls[0][0]).toBe("/xyz do a thing");
    expect(useRuntimeStore.getState().draft).toBe("");
  });
});

describe("conversation nav rail and scroll-to-latest", () => {
  function threadWith(blocks: ThreadBlock[]) {
    const index: Record<string, number> = {};
    blocks.forEach((block, i) => { index[block.id] = i; });
    useRuntimeStore.setState({ thread: { blocks, index, loaded: true } });
  }

  function scroller(): HTMLElement {
    const element = document.querySelector("[class*='overflow-y-auto']");
    if (!element) throw new Error("thread scroller not mounted");
    return element as HTMLElement;
  }

  it("keeps the conversation centred when the vertical scrollbar occupies space", async () => {
    threadWith([userBlock("u1", "Question"), agentBlock("a1", "Reply")]);
    await renderReady();
    expect(scroller()).toHaveClass("conversation-scroller", "overflow-y-auto");
  });

  it("shows one summary entry per user query once there are at least two", async () => {
    threadWith([
      userBlock("u1", "First question about models"),
      agentBlock("a1", "first reply"),
      userBlock("u2", "Second question about data"),
      agentBlock("a2", "second reply"),
    ]);
    await renderReady();
    const nav = screen.getByRole("navigation", { name: "Conversation" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "First question about models" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Second question about data" })).toBeInTheDocument();
  });

  it("loads indexed older user messages through sequential history pages", async () => {
    threadWith([
      userBlock("u-latest", "Latest question"),
      agentBlock("a-latest", "latest reply"),
    ]);
    useRuntimeStore.setState({ historyCursor: "cursor-latest", historyHasMore: true, historyLoading: false });
    overrides.push((url) => {
      if (url.startsWith("/api/sessions/s1/messages/index")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u-old", text: "Old question", before: "cursor-old" },
            { id: "u-latest", text: "Latest question", before: "cursor-latest" },
          ],
          snapshot_version: "1:1",
        }));
      }
      if (url.includes("/api/sessions/s1/messages?") && url.includes("before=cursor-latest")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u-middle", role: "user", content: [{ type: "text", text: "Middle question" }] },
            { id: "a-middle", role: "assistant", content: [{ type: "text", text: "middle reply" }] },
          ],
          next_cursor: "cursor-old",
          has_more: true,
          snapshot_version: "2:2",
        }));
      }
      if (url.includes("/api/sessions/s1/messages?") && url.includes("before=cursor-old")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u-old", role: "user", content: [{ type: "text", text: "Old question" }] },
            { id: "a-old", role: "assistant", content: [{ type: "text", text: "old reply" }] },
          ],
          next_cursor: null,
          has_more: false,
          snapshot_version: "3:3",
        }));
      }
      return null;
    });

    await renderReady();
    expect(await screen.findByRole("button", { name: "Old question" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Old question" }));

    await waitFor(() => expect(document.getElementById("user-msg-u-old")).toBeInTheDocument());
    const historyCalls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/api/sessions/s1/messages?"));
    expect(historyCalls).toEqual([
      "/api/sessions/s1/messages?cwd=proj&before=cursor-latest",
      "/api/sessions/s1/messages?cwd=proj&before=cursor-old",
    ]);
    expect(useRuntimeStore.getState().thread.blocks.map((block) => block.id)).toEqual([
      "u-old", "a-old", "u-middle", "a-middle", "u-latest", "a-latest",
    ]);
    await waitFor(() => expect(virtuosoProps.at(-1)?.firstItemIndex).toBe(99_998));
  });

  it("jumps to the selected user message on click", async () => {
    threadWith([
      userBlock("u1", "First question about models"),
      agentBlock("a1", "first reply"),
      userBlock("u2", "Second question about data"),
      agentBlock("a2", "second reply"),
    ]);
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "Second question about data" }));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ block: "start" }),
    );
  });

  it("does not follow the stream to the bottom after a rail jump", async () => {
    threadWith([
      userBlock("u1", "First question about models"),
      agentBlock("a1", "first reply"),
      userBlock("u2", "Second question about data"),
      agentBlock("a2", "second reply"),
    ]);
    await renderReady();
    const scrollerEl = scroller();
    Object.defineProperty(scrollerEl, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scrollerEl, "clientHeight", { value: 600, configurable: true });
    scrollerEl.scrollTop = 500;
    fireEvent.click(screen.getByRole("button", { name: "Second question about data" }));
    // A streamed block arrives: the follow-output effect must not yank the
    // viewport back to the bottom because the user is inspecting history.
    act(() => {
      useRuntimeStore.setState((state) => ({
        thread: { ...state.thread, blocks: [...state.thread.blocks, agentBlock("a3", "streamed reply")] },
      }));
    });
    expect(scrollerEl.scrollTop).toBe(500);
  });

  it("resumes following the stream after the arrow is clicked", async () => {
    threadWith([
      userBlock("u1", "First question about models"),
      agentBlock("a1", "first reply"),
    ]);
    await renderReady();
    const scrollerEl = scroller();
    Object.defineProperty(scrollerEl, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scrollerEl, "clientHeight", { value: 600, configurable: true });
    scrollerEl.scrollTop = 500;
    fireEvent.scroll(scrollerEl);
    fireEvent.click(await screen.findByLabelText("Back to latest"));
    // followOutputRef is true again: the next streamed block pins to the bottom.
    act(() => {
      useRuntimeStore.setState((state) => ({
        thread: { ...state.thread, blocks: [...state.thread.blocks, agentBlock("a2", "streamed reply")] },
      }));
    });
    expect(scrollerEl.scrollTop).toBe(2000);
  });

  it("shows the back-to-latest arrow after scrolling up and hides it near the bottom", async () => {
    threadWith([
      userBlock("u1", "First question about models"),
      agentBlock("a1", "first reply"),
    ]);
    await renderReady();
    const scrollerEl = scroller();
    Object.defineProperty(scrollerEl, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scrollerEl, "clientHeight", { value: 600, configurable: true });
    scrollerEl.scrollTop = 500;
    fireEvent.scroll(scrollerEl);
    const arrow = await screen.findByLabelText("Back to latest");
    expect(arrow).toBeInTheDocument();
    scrollerEl.scrollTop = 1940;
    fireEvent.scroll(scrollerEl);
    await waitFor(() => expect(screen.queryByLabelText("Back to latest")).toBeNull());
  });

  it("scrolls back to the bottom when the arrow is clicked", async () => {
    threadWith([
      userBlock("u1", "First question about models"),
      agentBlock("a1", "first reply"),
    ]);
    await renderReady();
    const scrollerEl = scroller();
    Object.defineProperty(scrollerEl, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scrollerEl, "clientHeight", { value: 600, configurable: true });
    scrollerEl.scrollTop = 500;
    fireEvent.scroll(scrollerEl);
    fireEvent.click(await screen.findByLabelText("Back to latest"));
    expect(Element.prototype.scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: 2000 }),
    );
  });

  it("shows the rail for a single user message", async () => {
    threadWith([userBlock("u1", "Only one question"), agentBlock("a1", "reply")]);
    await renderReady();
    expect(screen.getByRole("navigation", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Only one question" })).toHaveLength(1);
  });

  it("falls back to the attachment label for reference-only messages and truncates long ones", async () => {
    const longText = "x".repeat(200);
    threadWith([
      userBlock("u1", "<workspace_references>\n- file: \"/tmp/a.py\"\n</workspace_references>"),
      agentBlock("a1", "reply"),
      userBlock("u2", longText),
      agentBlock("a2", "reply"),
    ]);
    await renderReady();
    const attachment = screen.getByRole("button", { name: "Attachment" });
    expect(attachment).toBeInTheDocument();
    const longEntry = screen.getByRole("button", { name: longText.slice(0, 120) });
    expect(longEntry).toHaveAttribute("title", longText);
  });

  it("hides the rail when there are no user messages", async () => {
    threadWith([agentBlock("a1", "reply")]);
    await renderReady();
    expect(screen.queryByRole("navigation", { name: "Conversation" })).toBeNull();
  });

  it("highlights the rail entry for the user message in the viewport", async () => {
    threadWith([
      userBlock("u1", "First question about models"),
      agentBlock("a1", "first reply"),
      userBlock("u2", "Second question about data"),
      agentBlock("a2", "second reply"),
    ]);
    await renderReady();
    // jsdom reports zero scroll geometry, which would make the IO callback take
    // the near-bottom branch; give the scroller real heights first.
    const scrollerEl = scroller();
    Object.defineProperty(scrollerEl, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scrollerEl, "clientHeight", { value: 600, configurable: true });
    const io = IOStub.instances[IOStub.instances.length - 1];
    const target1 = document.getElementById("user-msg-u1");
    const target2 = document.getElementById("user-msg-u2");
    if (!target1 || !target2) throw new Error("user message anchors not rendered");
    act(() => {
      io.cb([
        { target: target1, isIntersecting: true, intersectionRatio: 0.9 } as unknown as IntersectionObserverEntry,
        { target: target2, isIntersecting: false, intersectionRatio: 0 } as unknown as IntersectionObserverEntry,
      ], io as unknown as IntersectionObserver);
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "First question about models" })).toHaveAttribute("aria-current", "true"),
    );
    expect(screen.getByRole("button", { name: "Second question about data" })).not.toHaveAttribute("aria-current");
  });

  it("grows the rail when a new user message streams in", async () => {
    threadWith([
      userBlock("u1", "First question about models"),
      agentBlock("a1", "first reply"),
      userBlock("u2", "Second question about data"),
      agentBlock("a2", "second reply"),
    ]);
    await renderReady();
    act(() => {
      threadWith([
        userBlock("u1", "First question about models"),
        agentBlock("a1", "first reply"),
        userBlock("u2", "Second question about data"),
        agentBlock("a2", "second reply"),
        userBlock("u3", "Third question about results"),
        agentBlock("a3", "third reply"),
      ]);
    });
    expect(await screen.findByRole("button", { name: "Third question about results" })).toBeInTheDocument();
  });
});

describe("header settings entry", () => {
  it("does not render a settings button in the header", async () => {
    useUiStore.setState({ settingsOpen: false });
    await renderReady();
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("toggles the execution ledger in place and exposes the selected state", async () => {
    await renderReady();
    const button = screen.getByRole("button", { name: "Session executions" });

    expect(button.previousElementSibling).toBe(screen.getByRole("heading", { level: 1 }));
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    expect(await screen.findByText("Execution ledger")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText("Execution ledger")).not.toBeInTheDocument());
    expect(button).toHaveAttribute("aria-pressed", "false");
  });
});

describe("scroll and nav behavior (docs/markdown.md §3.16 a/b/d)", () => {
  it("positions and highlights an execution target from the URL", async () => {
    useRuntimeStore.setState({
      thread: { blocks: [userBlock("u1", "Run a command"), toolBlock("call-1")], index: { u1: 0, "tool-call-1": 1 }, loaded: true },
    });

    renderPage("?focus=tool-call-1");

    const target = await waitFor(() => {
      const element = document.getElementById("thread-block-tool-call-1");
      expect(element).not.toBeNull();
      expect(element).toHaveClass("execution-focus-highlight");
      return element!;
    });
    expect(target.scrollIntoView).toHaveBeenCalled();
  });

  it("snaps to the bottom when a new turn starts (working false→true)", async () => {
    useRuntimeStore.setState({
      thread: { blocks: [userBlock("u1", "First question"), agentBlock("a1", "first reply")], index: { u1: 0, a1: 1 }, loaded: true },
    });
    await renderReady();
    const scroller = document.querySelector(".virtuoso-scroller") ?? document.querySelector(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    Object.defineProperty(scroller!, "scrollHeight", { value: 4000, configurable: true });
    (scroller as HTMLElement).scrollTop = 0;
    act(() => { useRuntimeStore.setState({ working: true }); });
    expect((scroller as HTMLElement).scrollTop).toBe(4000);
  });

  it("does not snap when the user is reading history (followOutputRef false)", async () => {
    useRuntimeStore.setState({
      thread: { blocks: [userBlock("u1", "First question"), agentBlock("a1", "first reply")], index: { u1: 0, a1: 1 }, loaded: true },
    });
    await renderReady();
    const scroller = (document.querySelector(".virtuoso-scroller") ?? document.querySelector(".overflow-y-auto")) as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", { value: 4000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 100, configurable: true });
    scroller.scrollTop = 3000;
    fireEvent.scroll(scroller); // nearBottom=false → followOutputRef=false
    act(() => { useRuntimeStore.setState({ working: true }); });
    expect(scroller.scrollTop).toBe(3000);
  });

  it("does not render suggestion chips in the composer seat", async () => {
    await renderReady();
    act(() => { useRuntimeStore.setState({ working: true }); });
    act(() => {
      useRuntimeStore.setState({
        working: false,
        thread: {
          blocks: [agentBlock("a1", "Saved outputs/plot.png\n<!--suggest: plot residuals-->")],
          index: { a1: 0 },
          loaded: true,
        },
      });
    });
    const chips = await screen.findByLabelText("Suggested follow-ups");
    expect(chips.closest(".px-8.shrink-0")).toBeNull();
  });

  it("nav click scrolls the target into view via the fast path", async () => {
    useRuntimeStore.setState({
      thread: {
        blocks: [userBlock("u1", "First question"), agentBlock("a1", "first reply")],
        index: { u1: 0, a1: 1 },
        loaded: true,
      },
    });
    await renderReady();
    const scrollIntoViewSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    try {
      fireEvent.click(await screen.findByRole("button", { name: "First question" }));
      expect(scrollIntoViewSpy).toHaveBeenCalled();
      const targetCall = scrollIntoViewSpy.mock.calls.find(
        (_args, index) => (scrollIntoViewSpy.mock.instances[index] as HTMLElement | null)?.id === "user-msg-u1",
      );
      expect(targetCall).toBeDefined();
      expect(targetCall![0]).toMatchObject({ behavior: "auto", block: "start" });
    } finally {
      scrollIntoViewSpy.mockRestore();
    }
  });

  it("falls back to group scroll when the fast path lands off-target", async () => {
    useRuntimeStore.setState({
      thread: {
        blocks: [userBlock("u1", "First question"), agentBlock("a1", "first reply")],
        index: { u1: 0, a1: 1 },
        loaded: true,
      },
    });
    await renderReady();
    const target = document.getElementById("user-msg-u1");
    expect(target).not.toBeNull();
    // Make the fast-path offset check reject: target sits far below the viewport.
    const fakeRect = {
      top: 1200, bottom: 1300, left: 0, right: 0, x: 0, y: 1200, width: 100, height: 100,
      toJSON: () => ({}),
    } as DOMRect;
    const originalRect = target!.getBoundingClientRect.bind(target!);
    target!.getBoundingClientRect = () => fakeRect;
    const scrollIntoViewSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    try {
      fireEvent.click(await screen.findByRole("button", { name: "First question" }));
      // Fast path rejected → Virtuoso scrollToIndex path schedules re-scrolls.
      await waitFor(() => {
        const targetCalls = scrollIntoViewSpy.mock.calls.filter(
          (_args, index) => (scrollIntoViewSpy.mock.instances[index] as HTMLElement | null)?.id === "user-msg-u1",
        );
        expect(targetCalls.length).toBeGreaterThanOrEqual(2);
      }, { timeout: 2000 });
    } finally {
      scrollIntoViewSpy.mockRestore();
      target!.getBoundingClientRect = originalRect;
    }
  });

  it("cancels pending nav-correction timers on unmount", async () => {
    useRuntimeStore.setState({
      thread: {
        blocks: [userBlock("u1", "First question"), agentBlock("a1", "first reply")],
        index: { u1: 0, a1: 1 },
        loaded: true,
      },
    });
    const view = await renderReady();
    const target = document.getElementById("user-msg-u1");
    expect(target).not.toBeNull();
    // Force the fast-path offset check to reject so the group-scroll branch
    // schedules its 120/350ms correction timers before we unmount.
    const fakeRect = {
      top: 1200, bottom: 1300, left: 0, right: 0, x: 0, y: 1200, width: 100, height: 100,
      toJSON: () => ({}),
    } as DOMRect;
    const originalRect = target!.getBoundingClientRect.bind(target!);
    target!.getBoundingClientRect = () => fakeRect;
    const scrollIntoViewSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    try {
      fireEvent.click(await screen.findByRole("button", { name: "First question" }));
      view.unmount();
      const callsAtUnmount = scrollIntoViewSpy.mock.calls.length;
      // Longer than both correction delays: stale callbacks must have been
      // cancelled by the unmount cleanup, not fired afterwards.
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(scrollIntoViewSpy.mock.calls.length).toBe(callsAtUnmount);
    } finally {
      scrollIntoViewSpy.mockRestore();
      target!.getBoundingClientRect = originalRect;
    }
  });
});

describe("defensive thread shape and copy actions (docs/pr30markdown.md 3.4/3.5/3.6)", () => {
  function toolBlock(id: string, tool: string): ThreadBlock {
    return { kind: "tool", id, callId: `${id}-call`, tool, status: "done", output: "tool output" };
  }

  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
  });

  it("renders the welcome composer without crashing when thread blocks are malformed", async () => {
    useRuntimeStore.setState({
      thread: { blocks: "garbage" as unknown as ThreadBlock[], index: {}, loaded: true },
    });
    await renderReady();
    expect(screen.getByLabelText("Send message")).toBeInTheDocument();
  });

  it("shows the copy action only on the final assistant answer", async () => {
    useRuntimeStore.setState({
      thread: {
        blocks: [
          userBlock("u1", "do the thing"),
          agentBlock("a1", "Let me check that for you."),
          toolBlock("t1", "read"),
          agentBlock("a2", "Here is the final answer."),
        ],
        index: { u1: 0, a1: 1, t1: 2, a2: 3 },
        loaded: true,
      },
    });
    await renderReady();

    // One copy button on the user message, one on the final assistant block —
    // the assistant narration before the tool call must not show one.
    const copyButtons = screen.getAllByRole("button", { name: "Copy" });
    expect(copyButtons).toHaveLength(2);
    const userMessage = document.getElementById("user-msg-u1")!;
    const agentCopy = copyButtons.find((button) => !userMessage.contains(button));
    expect(agentCopy).toBeDefined();

    fireEvent.click(agentCopy!);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Here is the final answer.");
  });

  it("hides the copy action when the turn ends on a tool call with no final assistant answer", async () => {
    useRuntimeStore.setState({
      thread: {
        blocks: [
          userBlock("u1", "do the thing"),
          agentBlock("a1", "Working on it."),
          toolBlock("t1", "read"),
        ],
        index: { u1: 0, a1: 1, t1: 2 },
        loaded: true,
      },
    });
    await renderReady();

    const copyButtons = screen.getAllByRole("button", { name: "Copy" });
    expect(copyButtons).toHaveLength(1);
  });
});

describe("session stats line", () => {
  it("mounts below the composer and renders the whole-session cumulative stats", async () => {
    useRuntimeStore.setState({
      thread: { blocks: [userBlock("u1", "hello")], index: { u1: 0 }, loaded: true },
    });
    await renderReady();
    const line = await screen.findByLabelText("Session stats");
    expect(line.textContent).toContain("2 turns");
    // Tool timing is rendered as a duration (DeepSeek-aligned format), not a count.
    expect(line.textContent).toContain("Tool call 1.0s");
    expect(line.textContent).toContain("500"); // output tokens
  });

  it("hides the stats line for a brand-new session with no turns", async () => {
    overrides.push((url) => url.startsWith("/api/sessions/s1/stats")
      ? Promise.resolve(jsonResponse({ ok: true, stats: {
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      } }))
      : null);
    useRuntimeStore.setState({ sessionStats: null });
    await renderReady();
    expect(screen.queryByLabelText("Session stats")).toBeNull();
  });
});
