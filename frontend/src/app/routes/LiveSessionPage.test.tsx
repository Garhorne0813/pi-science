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
 *   e. slash-command dispatcher (/compact, /name, unknown falls through to send)
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

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

import { LiveSessionPage } from "./LiveSessionPage";
import { WorkspaceProvider } from "../../lib/workspace-context";
import { FeedbackContext } from "../../components/feedback/feedback-context";
import { useRuntimeStore } from "../../lib/runtime-store";
import { useUiStore } from "../../lib/store";
import { queryClient } from "../../lib/query-client";
import { getSessionName } from "../../lib/pi-science-client";
import { resetDynamicCommands } from "../../lib/slash-commands";
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

function textarea(): HTMLTextAreaElement {
  const element = document.querySelector("textarea");
  if (!element) throw new Error("composer textarea not mounted");
  return element;
}

function sendButton(): HTMLElement {
  return screen.getByLabelText("Send message");
}

function renderPage() {
  return render(
    <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
      <MemoryRouter initialEntries={[`/workspace/${CWD}/session/${SESSION_ID}`]}>
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
  useUiStore.setState({ inspectorOpen: false, inspectorData: null, workspaceReferences: [] });
  useRuntimeStore.setState({
    status: "ready",
    client: null,
    sessions: [{ id: SESSION_ID, cwd: CWD, name: "Session" }],
    activeSessionId: SESSION_ID,
    cwd: CWD,
    thread: { blocks: [], index: {}, loaded: true },
    working: false,
    model: "prov/m1",
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
    sendPrompt: vi.fn(async (): Promise<string | null> => null),
    abort: vi.fn(async () => undefined),
    createNewSession: vi.fn(async () => "s2"),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});


describe("composer send-failure restore", () => {
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

  it("keeps workflow starters available after a conversation has already begun", async () => {
    useRuntimeStore.setState({
      thread: {
        blocks: [{ kind: "user", id: "u1", text: "Earlier analysis", timestamp: new Date().toISOString() }],
        index: { u1: 0 },
        loaded: true,
      },
    });

    await renderReady();

    expect(screen.getByRole("button", { name: "Optimize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reproduce experiment" })).toBeInTheDocument();
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
          blocks: [agentBlock("a1", "Saved outputs/plot.png\n<!--suggest: plot residuals-->")],
          index: { a1: 0 },
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
  it("/compact posts to the compact endpoint and reports it without sending a prompt", async () => {
    const sendPrompt = vi.fn(async (_message: string): Promise<string | null> => null);
    useRuntimeStore.setState({ sendPrompt });
    await renderReady();
    act(() => { useRuntimeStore.getState().setDraft("/compact"); });

    fireEvent.click(sendButton());

    await waitFor(() => expect(screen.getByText("Session compacted")).toBeInTheDocument());
    const compactCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/compact"));
    expect(compactCall).toBeDefined();
    expect(String(compactCall?.[0])).toBe(`/api/sessions/${SESSION_ID}/compact?cwd=${CWD}`);
    expect((compactCall?.[1] as RequestInit).method).toBe("POST");
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().draft).toBe("");
  });

  it("/name stores the session name locally and reports it (no toast)", async () => {
    const sendPrompt = vi.fn(async (_message: string): Promise<string | null> => null);
    useRuntimeStore.setState({ sendPrompt });
    await renderReady();
    act(() => { useRuntimeStore.getState().setDraft("/name Protein folding run"); });

    fireEvent.click(sendButton());

    await waitFor(() => expect(screen.getByText("Session renamed to Protein folding run")).toBeInTheDocument());
    expect(getSessionName(CWD, SESSION_ID)).toBe("Protein folding run");
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().draft).toBe("");
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
