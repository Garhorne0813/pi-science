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
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
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

import { LiveSessionPage } from "./LiveSessionPage";
import { WorkspaceProvider } from "../../lib/workspace";
import { FeedbackContext } from "../../components/feedback/feedback-context";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { FakeEventSource } from "../../lib/agent-runtime/test-helpers";
import { clearCachedMessages } from "../../lib/client/pi-science-client";
// The REAL store actions (captured before beforeEach replaces `connect` with
// a mock) so tests can exercise the actual connect/session-generation flow
// against scripted fetch responses.
const realConnect = useRuntimeStore.getState().connect;
const realDisconnect = useRuntimeStore.getState().disconnect;
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

function publishedArtifactBlock(path: string): ThreadBlock {
  return {
    kind: "status-line",
    id: `artifact-${path}`,
    text: `Published artifact: ${path}`,
    level: "done",
    path,
  };
}

/** IntersectionObserver stub that captures its callback so tests can drive
 *  the rail highlight logic manually (jsdom has no IO implementation). */
class IOStub {
  static instances: IOStub[] = [];
  cb: IntersectionObserverCallback;
  targets: Element[] = [];
  root: Element | null;
  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.cb = cb;
    this.root = options?.root instanceof Element ? options.root : null;
    IOStub.instances.push(this);
  }
  observe(target: Element) {
    // Real IntersectionObservers ignore re-observing an already-observed
    // target; mirror that so the settle re-registration stays idempotent.
    if (!this.targets.includes(target)) this.targets.push(target);
  }
  unobserve() {}
  disconnect() {}
}

/** MutationObserver stub: the rail observes the scroller for added
 *  user-message nodes; tests drive the captured callback directly. */
class MOStub {
  static instances: MOStub[] = [];
  cb: MutationCallback;
  constructor(cb: MutationCallback) {
    this.cb = cb;
    MOStub.instances.push(this);
  }
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
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
  virtuosoProps.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  IOStub.instances = [];
  MOStub.instances = [];
  vi.stubGlobal("IntersectionObserver", IOStub);
  vi.stubGlobal("MutationObserver", MOStub);
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
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
    working: false,
    model: "prov/m1",
    thinking: "high",
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    compactionEnabled: true,
    compactionThresholdPercent: null,
    pendingInteraction: null,
    pendingQuestionnaire: null,
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
  it("uses the compact conversation header height", async () => {
    await renderReady();
    expect(screen.getByRole("banner")).toHaveClass("h-9");
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
    expect(footerView.container).toHaveTextContent("Working…");

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
    // Prefer react-virtuoso's own scroller hooks: the open bookmarks panel
    // and the rail's minimap also carry overflow-y-auto, so a bare
    // class-substring match can land on the wrong element.
    const element = document.querySelector(".virtuoso-scroller")
      ?? document.querySelector(".conversation-scroller")
      ?? document.querySelector("[class*='overflow-y-auto']");
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

  it("shows indexed older user messages and loads their page when selected", async () => {
    threadWith([
      userBlock("u-latest", "Latest question"),
      agentBlock("a-latest", "latest reply"),
    ]);
    overrides.push((url) => {
      if (url.startsWith("/api/sessions/s1/messages/index")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u-old", role: "user", text: "Old question", before: "cursor-old" },
            { id: "u-latest", role: "user", text: "Latest question", before: "cursor-latest" },
          ],
          snapshot_version: "1:1",
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
          snapshot_version: "2:2",
        }));
      }
      return null;
    });

    await renderReady();
    expect(await screen.findByRole("button", { name: "Old question" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Old question" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/sessions/s1/messages?cwd=proj&before=cursor-old"))).toBe(true));
    await waitFor(() => expect(document.getElementById("user-msg-u-old")).toBeInTheDocument());
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
});

describe("scroll and nav behavior (docs/markdown.md §3.16 a/b/d)", () => {
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

  it("renders suggestion chips above the research-mode picker", async () => {
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
    // The chips container must be the first child of the picker column, i.e.
    // rendered ABOVE the research-mode picker (docs §3.16 d).
    expect(chips.parentElement?.firstElementChild).toBe(chips);
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

  it("shows the copy action only on the final assistant answer, copying the merged turn text", async () => {
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
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "Let me check that for you.\n\nHere is the final answer.",
    );
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

describe("durable navigation (bookmarks + read position)", () => {
  const INDEX_URL = "/api/sessions/s1/messages/index";

  function threadWith(blocks: ThreadBlock[]) {
    const index: Record<string, number> = {};
    blocks.forEach((block, i) => { index[block.id] = i; });
    useRuntimeStore.setState({ thread: { blocks, index, loaded: true } });
  }

  function allRoleIndex(entries: Array<{ id: string; role: string; text: string; before: string }>) {
    overrides.push((url) => {
      if (url.startsWith(INDEX_URL)) {
        return Promise.resolve(jsonResponse({ messages: entries, snapshot_version: "1:1" }));
      }
      return null;
    });
  }

  it("restores a saved reading position in an older page after refresh", async () => {
    threadWith([userBlock("u-latest", "Latest question"), agentBlock("a-latest", "latest reply")]);
    allRoleIndex([
      { id: "u-old", role: "user", text: "Old question", before: "cursor-old" },
      { id: "a-old", role: "assistant", text: "Old answer", before: "cursor-old" },
      { id: "u-latest", role: "user", text: "Latest question", before: "cursor-latest" },
    ]);
    overrides.push((url) => {
      if (url.startsWith("/api/sessions/s1/read-state")) {
        return Promise.resolve(jsonResponse({
          session_id: "s1", anchor_message_id: "u-old", at_bottom: false,
          seen_snapshot_version: null, updated_at: "now", anchor_available: true, before: "cursor-old",
        }));
      }
      if (url.includes("/api/sessions/s1/messages?") && url.includes("before=cursor-old")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u-old", role: "user", content: [{ type: "text", text: "Old question" }] },
            { id: "a-old", role: "assistant", content: [{ type: "text", text: "Old answer" }] },
          ],
          next_cursor: null, has_more: false, snapshot_version: "2:2",
        }));
      }
      return null;
    });

    await renderReady();
    await waitFor(() => expect(document.getElementById("user-msg-u-old")).toBeInTheDocument());
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("keeps the bottom behavior when the read state is at_bottom", async () => {
    threadWith([userBlock("u1", "Question"), agentBlock("a1", "reply")]);
    allRoleIndex([{ id: "u1", role: "user", text: "Question", before: "cursor-latest" }]);
    overrides.push((url) => {
      if (url.startsWith("/api/sessions/s1/read-state")) {
        return Promise.resolve(jsonResponse({
          session_id: "s1", anchor_message_id: "u1", at_bottom: true,
          seen_snapshot_version: "1:1", updated_at: "now", anchor_available: true, before: "cursor-latest",
        }));
      }
      return null;
    });

    await renderReady();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The at-bottom restore must not trigger an older-page load.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/sessions/s1/messages?") && String(url).includes("before="))).toBe(false);
  });

  it("jumps to an assistant bookmark in an older page from the bookmarks panel", async () => {
    threadWith([userBlock("u-latest", "Latest question"), agentBlock("a-latest", "latest reply")]);
    allRoleIndex([
      { id: "a-old", role: "assistant", text: "Old answer", before: "cursor-old" },
      { id: "u-latest", role: "user", text: "Latest question", before: "cursor-latest" },
    ]);
    overrides.push((url) => {
      if (url.includes("/api/bookmarks")) {
        return Promise.resolve(jsonResponse({
          bookmarks: [
            { bookmark_id: "b1", session_id: "s1", message_id: "a-old", role: "assistant", quote: "Old answer", label: null, origin: "user", status: "accepted", created_at: "now", updated_at: "now" },
          ],
          legacy_skipped: 0,
        }));
      }
      if (url.includes("/api/sessions/s1/messages?") && url.includes("before=cursor-old")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u-old", role: "user", content: [{ type: "text", text: "Old question" }] },
            { id: "a-old", role: "assistant", content: [{ type: "text", text: "Old answer" }] },
          ],
          next_cursor: null, has_more: false, snapshot_version: "2:2",
        }));
      }
      return null;
    });

    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "Bookmarks" }));
    fireEvent.click(await screen.findByRole("button", { name: /Jump to message/ }));
    await waitFor(() => expect(document.getElementById("agent-msg-a-old")).toBeInTheDocument());
  });

  it("offers bookmark actions only for messages confirmed by the server index", async () => {
    threadWith([userBlock("u-live", "not yet persisted"), agentBlock("a1", "settled answer")]);
    allRoleIndex([{ id: "a1", role: "assistant", text: "settled answer", before: "cursor-a1" }]);
    await renderReady();
    // Wait for the virtual list to mount both message rows.
    await waitFor(() => expect(document.getElementById("user-msg-u-live")).not.toBeNull());
    await waitFor(() => expect(document.getElementById("agent-msg-a1")).not.toBeNull());

    // The live user block has no bookmark button; the indexed agent block does.
    const liveRow = document.getElementById("user-msg-u-live")!;
    expect(liveRow.querySelector('[aria-label="Bookmark message"]')).toBeNull();
    const agentRow = document.getElementById("agent-msg-a1")!;
    expect(agentRow.querySelector('[aria-label="Bookmark message"]')).not.toBeNull();
    // Exactly one bookmark toggle in the whole thread.
    expect(screen.getAllByRole("button", { name: "Bookmark message" })).toHaveLength(1);
  });

  it("creates a bookmark from the message toggle and shows the header count", async () => {
    threadWith([userBlock("u1", "Question"), agentBlock("a1", "answer")]);
    allRoleIndex([
      { id: "u1", role: "user", text: "Question", before: "c1" },
      { id: "a1", role: "assistant", text: "answer", before: "c2" },
    ]);
    const createdBookmark = { bookmark_id: "b-new", session_id: "s1", message_id: "u1", role: "user", quote: "Question", label: null, origin: "user", status: "accepted", created_at: "now", updated_at: "now" };
    let posted = false;
    overrides.push((url, init) => {
      if (String(url).includes("/api/bookmarks") && init?.method === "POST") {
        posted = true;
        return Promise.resolve(jsonResponse({ bookmark: createdBookmark }));
      }
      if (String(url).includes("/api/bookmarks")) {
        // The refetch after the mutation must reflect the created bookmark.
        return Promise.resolve(jsonResponse({ bookmarks: posted ? [createdBookmark] : [], legacy_skipped: 0 }));
      }
      return null;
    });

    await renderReady();
    // Wait for both the virtual list row and the all-role index (which makes
    // the bookmark toggle eligible) to be ready.
    await waitFor(() => {
      const row = document.getElementById("user-msg-u1");
      expect(row?.querySelector('[aria-label="Bookmark message"]')).not.toBeNull();
    });
    const userRow = document.getElementById("user-msg-u1")!;
    fireEvent.click(userRow.querySelector('[aria-label="Bookmark message"]')!);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes("/api/bookmarks") && init?.method === "POST")).toBe(true));
    // The mutation invalidates the bookmarks query; the header count reflects
    // the new accepted bookmark once refetched.
    await waitFor(() => expect(screen.getByRole("button", { name: "Bookmarks" }).textContent).toContain("1"));
  });
});

describe("durable navigation review fixes", () => {
  const INDEX_URL = "/api/sessions/s1/messages/index";

  function threadWith(blocks: ThreadBlock[]) {
    const index: Record<string, number> = {};
    blocks.forEach((block, i) => { index[block.id] = i; });
    useRuntimeStore.setState({ thread: { blocks, index, loaded: true } });
  }

  function allRoleIndex(entries: Array<{ id: string; role: string; text: string; before: string }>) {
    overrides.push((url) => {
      if (url.startsWith(INDEX_URL)) {
        return Promise.resolve(jsonResponse({ messages: entries, snapshot_version: "1:1" }));
      }
      return null;
    });
  }

  it("reconciles an optimistic user block with its persisted index entry", async () => {
    threadWith([userBlock("user-123", "Question"), agentBlock("a1", "answer")]);
    allRoleIndex([
      { id: "m-real", role: "user", text: "Question", before: "c1" },
      { id: "a1", role: "assistant", text: "answer", before: "c2" },
    ]);
    overrides.push((url, init) => {
      if (String(url).includes("/api/bookmarks") && init?.method === "POST") {
        return Promise.resolve(jsonResponse({
          bookmark: { bookmark_id: "b-opt", session_id: "s1", message_id: "m-real", role: "user", quote: "Question", label: null, origin: "user", status: "accepted", created_at: "now", updated_at: "now" },
        }));
      }
      if (String(url).includes("/api/bookmarks")) {
        return Promise.resolve(jsonResponse({ bookmarks: [], legacy_skipped: 0 }));
      }
      return null;
    });

    await renderReady();
    // The optimistic block gets a bookmark toggle (resolved to the persisted id).
    await waitFor(() => {
      const row = document.getElementById("user-msg-user-123");
      expect(row?.querySelector('[aria-label="Bookmark message"]')).not.toBeNull();
    });
    // The nav rail shows ONE entry for the question: the temp block is
    // reconciled to the persisted entry instead of duplicating it.
    expect(screen.getAllByRole("button", { name: "Question" })).toHaveLength(1);

    fireEvent.click(document.getElementById("user-msg-user-123")!.querySelector('[aria-label="Bookmark message"]')!);
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url, init]) => String(url).includes("/api/bookmarks") && init?.method === "POST");
      expect(post).toBeTruthy();
      expect(String(post![1]?.body)).toContain('"message_id":"m-real"');
    });
  });

  it("hides rejected bookmarks from the panel, actions and header count", async () => {
    threadWith([userBlock("u1", "Question"), agentBlock("a1", "answer")]);
    allRoleIndex([
      { id: "u1", role: "user", text: "Question", before: "c1" },
      { id: "a1", role: "assistant", text: "answer", before: "c2" },
    ]);
    overrides.push((url) => {
      if (String(url).includes("/api/bookmarks")) {
        return Promise.resolve(jsonResponse({
          bookmarks: [
            { bookmark_id: "b-rej", session_id: "s1", message_id: "u1", role: "user", quote: "Question", label: null, origin: "user", status: "rejected", created_at: "now", updated_at: "now" },
          ],
          legacy_skipped: 0,
        }));
      }
      return null;
    });

    await renderReady();
    await waitFor(() => {
      const row = document.getElementById("user-msg-u1");
      expect(row?.querySelector('[aria-label="Bookmark message"]')).not.toBeNull();
    });
    // Rejected records are invisible: no header count, empty panel, and the
    // message toggle still offers to create (which revives server-side).
    expect(screen.getByRole("button", { name: "Bookmarks" }).textContent).not.toContain("1");
    fireEvent.click(screen.getByRole("button", { name: "Bookmarks" }));
    expect(await screen.findByText(/No bookmarks yet/i)).toBeInTheDocument();
    // Both indexed messages still offer to create (a rejected record is
    // invisible; creating revives it server-side).
    const row = document.getElementById("user-msg-u1")!;
    expect(row.querySelector('[aria-label="Bookmark message"]')).not.toBeNull();
  });

  it("direct-scrolls to a mounted bookmark target when the page load returns zero", async () => {
    threadWith([userBlock("u1", "Question"), agentBlock("a1", "answer")]);
    allRoleIndex([
      { id: "u1", role: "user", text: "Question", before: "c1" },
      { id: "a1", role: "assistant", text: "answer", before: "c2" },
    ]);
    overrides.push((url) => {
      if (String(url).includes("/api/bookmarks")) {
        return Promise.resolve(jsonResponse({
          bookmarks: [
            { bookmark_id: "b1", session_id: "s1", message_id: "u1", role: "user", quote: "Question", label: null, origin: "user", status: "accepted", created_at: "now", updated_at: "now" },
          ],
          legacy_skipped: 0,
        }));
      }
      if (String(url).includes("/api/sessions/s1/messages?") && String(url).includes("before=c1")) {
        return Promise.resolve(jsonResponse({ messages: [], next_cursor: null, has_more: false, snapshot_version: "2:2" }));
      }
      return null;
    });

    await renderReady();
    (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Bookmarks" }));
    fireEvent.click(await screen.findByRole("button", { name: /Jump to message/ }));
    // The empty page resolves 0; after bounded retries the direct-scroll
    // fallback fires for the already-mounted target.
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it("returns focus to the trigger when the bookmarks panel closes", async () => {
    threadWith([userBlock("u1", "Question"), agentBlock("a1", "answer")]);
    allRoleIndex([{ id: "u1", role: "user", text: "Question", before: "c1" }]);
    await renderReady();
    const trigger = screen.getByRole("button", { name: "Bookmarks" });
    fireEvent.click(trigger);
    expect(await screen.findByRole("region", { name: "Bookmarks" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Bookmarks" })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it("does not let a stale previous-session restore act on the current session", async () => {
    function SwitchButton() {
      const navigate = useNavigate();
      return (
        <button
          type="button"
          onClick={() => {
            // The real navigation flow updates the store's active session
            // before the route change; mirror it so history loads target s2.
            // (historyLoading is reset here because the pre-existing store
            // loadHistoryPage keeps it true when a mid-flight load's session
            // no longer matches — not part of this review's scope.)
            useRuntimeStore.setState({ activeSessionId: "s2", historyLoading: false });
            navigate(`/workspace/${CWD}/session/s2`);
          }}
        >
          switch-session
        </button>
      );
    }
    overrides.push((url) => {
      if (url.startsWith("/api/sessions/s1/read-state")) {
        return Promise.resolve(jsonResponse({
          session_id: "s1", anchor_message_id: "u1-old", at_bottom: false,
          seen_snapshot_version: null, updated_at: "now", anchor_available: true, before: "cur-s1",
        }));
      }
      if (url.startsWith("/api/sessions/s2/read-state")) {
        return Promise.resolve(jsonResponse({
          session_id: "s2", anchor_message_id: "u2-old", at_bottom: false,
          seen_snapshot_version: null, updated_at: "now", anchor_available: true, before: "cur-s2",
        }));
      }
      if (String(url).includes("/api/sessions/s1/messages?") && String(url).includes("before=cur-s1")) {
        // Resolves only AFTER the session switch; the stale promise must be dropped.
        return new Promise((resolve) => setTimeout(() => resolve(jsonResponse({
          messages: [
            { id: "u1-old", role: "user", content: [{ type: "text", text: "Old s1 question" }] },
            { id: "a1-old", role: "assistant", content: [{ type: "text", text: "Old s1 answer" }] },
          ],
          next_cursor: null, has_more: false, snapshot_version: "2:2",
        })), 400));
      }
      if (String(url).includes("/api/sessions/s2/messages?") && String(url).includes("before=cur-s2")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u2-old", role: "user", content: [{ type: "text", text: "Old s2 question" }] },
            { id: "a2-old", role: "assistant", content: [{ type: "text", text: "Old s2 answer" }] },
          ],
          next_cursor: null, has_more: false, snapshot_version: "2:2",
        }));
      }
      return null;
    });
    threadWith([userBlock("u1", "Question"), agentBlock("a1", "answer")]);
    useRuntimeStore.setState({ sessions: [
      { id: "s1", cwd: CWD, name: "Session" },
      { id: "s2", cwd: CWD, name: "Session 2" },
    ] });

    const view = render(
      <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
        <MemoryRouter initialEntries={[`/workspace/${CWD}/session/s1`]}>
          <Routes>
            <Route path="/workspace/:cwd/session/:sessionId" element={<WorkspaceProvider><SwitchButton /><LiveSessionPage /></WorkspaceProvider>} />
          </Routes>
        </MemoryRouter>
      </FeedbackContext.Provider>,
    );
    await screen.findByTestId("model-control");
    (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();

    // Switch to s2 while s1's restore page is still in flight.
    fireEvent.click(screen.getByRole("button", { name: "switch-session" }));
    // s2's own restore completes with its anchor mounted; the retry loop's
    // final correction scroll lands within a settle window.
    await waitFor(() => expect(document.getElementById("user-msg-u2-old")).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 400));
    const callsAfterS2 = (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterS2).toBeGreaterThanOrEqual(1);
    // Let s1's delayed page resolve: it must NOT scroll the stale target.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterS2);
    expect(document.getElementById("user-msg-u1-old")).toBeNull();
    view.unmount();
  });
});

describe("reading-position restore robustness", () => {
  const INDEX_URL = "/api/sessions/s1/messages/index";

  function threadWith(blocks: ThreadBlock[]) {
    const index: Record<string, number> = {};
    blocks.forEach((block, i) => { index[block.id] = i; });
    useRuntimeStore.setState({ thread: { blocks, index, loaded: true } });
  }

  function allRoleIndex(entries: Array<{ id: string; role: string; text: string; before: string }>) {
    overrides.push((url) => {
      if (url.startsWith(INDEX_URL)) {
        return Promise.resolve(jsonResponse({ messages: entries, snapshot_version: "1:1" }));
      }
      return null;
    });
  }

  function scroller(): HTMLElement {
    // Prefer react-virtuoso's own scroller hooks: the open bookmarks panel
    // and the rail's minimap also carry overflow-y-auto, so a bare
    // class-substring match can land on the wrong element.
    const element = document.querySelector(".virtuoso-scroller")
      ?? document.querySelector(".conversation-scroller")
      ?? document.querySelector("[class*='overflow-y-auto']");
    if (!element) throw new Error("thread scroller not mounted");
    return element as HTMLElement;
  }

  it("keeps retrying past a transient zero page load and restores the anchor", async () => {
    threadWith([userBlock("u-latest", "Latest question"), agentBlock("a-latest", "latest reply")]);
    allRoleIndex([
      { id: "u-old", role: "user", text: "Old question", before: "cursor-old" },
      { id: "a-old", role: "assistant", text: "Old answer", before: "cursor-old" },
      { id: "u-latest", role: "user", text: "Latest question", before: "cursor-latest" },
    ]);
    let pageLoads = 0;
    overrides.push((url) => {
      if (url.startsWith("/api/sessions/s1/read-state")) {
        return Promise.resolve(jsonResponse({
          session_id: "s1", anchor_message_id: "u-old", at_bottom: false,
          seen_snapshot_version: null, updated_at: "now", anchor_available: true, before: "cursor-old",
        }));
      }
      if (url.includes("/api/sessions/s1/messages?") && url.includes("before=cursor-old")) {
        pageLoads += 1;
        // The first page load lands while the newest page is still loading:
        // the store refuses the history load and returns zero without
        // prepending anything. The restore must retry instead of giving up
        // after a few hundred milliseconds.
        if (pageLoads === 1) {
          return Promise.resolve(jsonResponse({ messages: [], next_cursor: null, has_more: false, snapshot_version: "2:2" }));
        }
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u-old", role: "user", content: [{ type: "text", text: "Old question" }] },
            { id: "a-old", role: "assistant", content: [{ type: "text", text: "Old answer" }] },
          ],
          next_cursor: null, has_more: false, snapshot_version: "2:2",
        }));
      }
      return null;
    });

    await renderReady();
    await waitFor(() => expect(document.getElementById("user-msg-u-old")).toBeInTheDocument());
    expect(pageLoads).toBeGreaterThanOrEqual(2);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("does not snap back to the bottom when blocks arrive after the restore", async () => {
    threadWith([userBlock("u-latest", "Latest question"), agentBlock("a-latest", "latest reply")]);
    allRoleIndex([
      { id: "u-old", role: "user", text: "Old question", before: "cursor-old" },
      { id: "u-latest", role: "user", text: "Latest question", before: "cursor-latest" },
    ]);
    overrides.push((url) => {
      if (url.startsWith("/api/sessions/s1/read-state")) {
        return Promise.resolve(jsonResponse({
          session_id: "s1", anchor_message_id: "u-old", at_bottom: false,
          seen_snapshot_version: null, updated_at: "now", anchor_available: true, before: "cursor-old",
        }));
      }
      if (url.includes("/api/sessions/s1/messages?") && url.includes("before=cursor-old")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u-old", role: "user", content: [{ type: "text", text: "Old question" }] },
            { id: "a-old", role: "assistant", content: [{ type: "text", text: "Old answer" }] },
          ],
          next_cursor: null, has_more: false, snapshot_version: "2:2",
        }));
      }
      return null;
    });

    await renderReady();
    await waitFor(() => expect(document.getElementById("user-msg-u-old")).toBeInTheDocument());
    // Position the scroller where the restore left it, then append live blocks
    // the way a streaming turn would. The follow-output snap-to-bottom must
    // NOT run: the restored position is the user's place, not the newest end.
    const scrollerEl = scroller();
    scrollerEl.scrollTop = 500;
    act(() => {
      const state = useRuntimeStore.getState();
      useRuntimeStore.setState({
        thread: {
          blocks: [...state.thread.blocks, userBlock("u-live", "Latest live question")],
          index: { ...state.thread.index, "u-live": state.thread.blocks.length },
          loaded: true,
        },
      });
    });
    expect(scrollerEl.scrollTop).toBe(500);
  });

  it("resolves optimistic user ids to persisted ids before persisting the anchor", async () => {
    threadWith([userBlock("user-123", "Question"), agentBlock("a1", "answer")]);
    allRoleIndex([
      { id: "m-real", role: "user", text: "Question", before: "c1" },
      { id: "a1", role: "assistant", text: "answer", before: "c2" },
    ]);
    overrides.push((url) => {
      if (url.startsWith("/api/sessions/s1/read-state")) {
        // No saved position: the restore releases viewport-driven writes.
        return Promise.resolve(jsonResponse({
          session_id: "s1", anchor_message_id: null, at_bottom: false,
          seen_snapshot_version: null, updated_at: null, anchor_available: false, before: null,
        }));
      }
      return null;
    });

    await renderReady();
    // Give the scroller real geometry so the rail does not treat every
    // position as near-bottom (jsdom reports zero sizes by default).
    const scrollerEl = scroller();
    Object.defineProperty(scrollerEl, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(scrollerEl, "clientHeight", { configurable: true, value: 400 });
    scrollerEl.scrollTop = 100;
    // Wait for the restore decision (no saved position) so writes are live.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The rail's intersection observer reports the optimistic block's DOM id;
    // the anchor write must carry the persisted id, not the temporary one.
    const io = IOStub.instances.at(-1)!;
    act(() => {
      io.cb([{
        target: { id: "user-msg-user-123" },
        isIntersecting: true,
        intersectionRatio: 1,
      }] as unknown as IntersectionObserverEntry[], io as unknown as IntersectionObserver);
    });
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([url, init]) => init?.method === "PUT" && String(url).includes("/api/sessions/s1/read-state"));
      expect(put).toBeTruthy();
      expect(String(put![1]?.body)).toContain('"anchor_message_id":"m-real"');
    });
  });

  it("falls back to the bottom when the saved anchor is gone (compaction/rewrite) and keeps writes live", async () => {
    // Two user messages: the rail's mount-time near-bottom report (jsdom
    // geometry is zero, so it picks the LAST user message) must not swallow
    // the active-id change driven below — the IO target is the FIRST message.
    threadWith([userBlock("u1", "Question"), agentBlock("a1", "answer"), userBlock("u2", "Follow-up"), agentBlock("a2", "reply")]);
    allRoleIndex([
      { id: "u1", role: "user", text: "Question", before: "c1" },
      { id: "a1", role: "assistant", text: "answer", before: "c2" },
      { id: "u2", role: "user", text: "Follow-up", before: "c3" },
      { id: "a2", role: "assistant", text: "reply", before: "c4" },
    ]);
    overrides.push((url) => {
      if (url.startsWith("/api/sessions/s1/read-state")) {
        // The anchor id no longer exists in the transcript (compaction,
        // rewrite, or a non-indexed message): the server reports it as
        // unavailable and the restore must fall back to the bottom — no
        // older-page fetch, no stuck write suppression.
        return Promise.resolve(jsonResponse({
          session_id: "s1", anchor_message_id: "u-gone", at_bottom: false,
          seen_snapshot_version: null, updated_at: "now", anchor_available: false, before: null,
        }));
      }
      return null;
    });

    await renderReady();
    await waitFor(() => expect(document.getElementById("user-msg-u1")).toBeInTheDocument());
    // Give the restore decision (no anchor) time to release the writes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/sessions/s1/messages?") && String(url).includes("before="))).toBe(false);

    // The user scrolls to another message: the viewport-driven write must
    // fire, proving the restore did not leave suppression stuck.
    const scrollerEl = scroller();
    Object.defineProperty(scrollerEl, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(scrollerEl, "clientHeight", { configurable: true, value: 400 });
    scrollerEl.scrollTop = 100;
    const io = IOStub.instances.at(-1)!;
    act(() => {
      io.cb([{
        target: { id: "user-msg-u1" },
        isIntersecting: true,
        intersectionRatio: 1,
      }] as unknown as IntersectionObserverEntry[], io as unknown as IntersectionObserver);
    });
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([url, init]) => init?.method === "PUT" && String(url).includes("/api/sessions/s1/read-state"));
      expect(put).toBeTruthy();
      expect(String(put![1]?.body)).toContain('"anchor_message_id":"u1"');
    });
  });

  it("restores an assistant-message anchor from an older page", async () => {
    threadWith([userBlock("u-latest", "Latest question"), agentBlock("a-latest", "latest reply")]);
    allRoleIndex([
      { id: "u-old", role: "user", text: "Old question", before: "cursor-old" },
      { id: "a-old", role: "assistant", text: "Old answer", before: "cursor-old" },
      { id: "u-latest", role: "user", text: "Latest question", before: "cursor-latest" },
    ]);
    overrides.push((url) => {
      if (url.startsWith("/api/sessions/s1/read-state")) {
        // Legacy/read states may anchor an assistant message.
        return Promise.resolve(jsonResponse({
          session_id: "s1", anchor_message_id: "a-old", at_bottom: false,
          seen_snapshot_version: null, updated_at: "now", anchor_available: true, before: "cursor-old",
        }));
      }
      if (url.includes("/api/sessions/s1/messages?") && url.includes("before=cursor-old")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u-old", role: "user", content: [{ type: "text", text: "Old question" }] },
            { id: "a-old", role: "assistant", content: [{ type: "text", text: "Old answer" }] },
          ],
          next_cursor: null, has_more: false, snapshot_version: "2:2",
        }));
      }
      return null;
    });

    await renderReady();
    await waitFor(() => expect(document.getElementById("agent-msg-a-old")).toBeInTheDocument());
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("still restores when the read state arrives after the safety timeout", async () => {
    threadWith([userBlock("u-latest", "Latest question"), agentBlock("a-latest", "latest reply")]);
    allRoleIndex([
      { id: "u-old", role: "user", text: "Old question", before: "cursor-old" },
      { id: "a-old", role: "assistant", text: "Old answer", before: "cursor-old" },
      { id: "u-latest", role: "user", text: "Latest question", before: "cursor-latest" },
    ]);
    let resolveReadState: (value: Response) => void = () => {};
    overrides.push((url) => {
      if (url.startsWith("/api/sessions/s1/read-state")) {
        // The read-state GET hangs well past the 8s safety timeout.
        return new Promise<Response>((resolve) => { resolveReadState = resolve; });
      }
      if (url.includes("/api/sessions/s1/messages?") && url.includes("before=cursor-old")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u-old", role: "user", content: [{ type: "text", text: "Old question" }] },
            { id: "a-old", role: "assistant", content: [{ type: "text", text: "Old answer" }] },
          ],
          next_cursor: null, has_more: false, snapshot_version: "2:2",
        }));
      }
      return null;
    });

    vi.useFakeTimers();
    try {
      renderPage();
      // Initial queries and lazy Virtuoso settle.
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      // The safety timeout expires while the read-state GET is still in
      // flight: it must release the write suppression WITHOUT marking the
      // restore done, so the late-arriving read state can still restore.
      await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
      await act(async () => {
        resolveReadState(jsonResponse({
          session_id: "s1", anchor_message_id: "u-old", at_bottom: false,
          seen_snapshot_version: null, updated_at: "now", anchor_available: true, before: "cursor-old",
        }));
        await vi.advanceTimersByTimeAsync(10);
      });
      // The restore loads the older page and scrolls to the anchor.
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("before=cursor-old"))).toBe(true);
      expect(document.getElementById("user-msg-u-old")).toBeInTheDocument();
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restore when the user manually scrolls while the read state is still loading", async () => {
    threadWith([userBlock("u-latest", "Latest question"), agentBlock("a-latest", "latest reply")]);
    allRoleIndex([
      { id: "u-old", role: "user", text: "Old question", before: "cursor-old" },
      { id: "a-old", role: "assistant", text: "Old answer", before: "cursor-old" },
      { id: "u-latest", role: "user", text: "Latest question", before: "cursor-latest" },
    ]);
    let resolveReadState: (value: Response) => void = () => {};
    overrides.push((url) => {
      if (url.startsWith("/api/sessions/s1/read-state")) {
        // The read-state GET hangs: the restore decision stays open while the
        // user reads history manually.
        return new Promise<Response>((resolve) => { resolveReadState = resolve; });
      }
      if (url.includes("/api/sessions/s1/messages?") && url.includes("before=cursor-old")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u-old", role: "user", content: [{ type: "text", text: "Old question" }] },
            { id: "a-old", role: "assistant", content: [{ type: "text", text: "Old answer" }] },
          ],
          next_cursor: null, has_more: false, snapshot_version: "2:2",
        }));
      }
      return null;
    });

    await renderReady();
    // Let the entry bottom-snap programmatic-scroll window expire so the
    // manual scroll below is classified as a user interaction.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const scrollerEl = scrollerWithGeometry();
    scrollerEl.scrollTop = 100;
    fireEvent.scroll(scrollerEl);
    // The late read-state response carries a saved older anchor.
    await act(async () => {
      resolveReadState(jsonResponse({
        session_id: "s1", anchor_message_id: "u-old", at_bottom: false,
        seen_snapshot_version: null, updated_at: "now", anchor_available: true, before: "cursor-old",
      }));
    });
    // The restore must NOT start: no older-page load, no anchor scroll, no
    // anchor mount.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("before=cursor-old"))).toBe(false);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(document.getElementById("user-msg-u-old")).not.toBeInTheDocument();
    // The restore decision released the write suppression: the viewport's
    // current anchor persists instead of being dropped.
    driveActiveAnchor("u-old");
    await expectAnchorWrite("u-old");
  });

  it("does not restore when the user wheels inside the programmatic-scroll grace while the read state is still loading", async () => {
    threadWith([userBlock("u-latest", "Latest question"), agentBlock("a-latest", "latest reply")]);
    allRoleIndex([
      { id: "u-old", role: "user", text: "Old question", before: "cursor-old" },
      { id: "a-old", role: "assistant", text: "Old answer", before: "cursor-old" },
      { id: "u-latest", role: "user", text: "Latest question", before: "cursor-latest" },
    ]);
    let resolveReadState: (value: Response) => void = () => {};
    overrides.push((url) => {
      if (url.startsWith("/api/sessions/s1/read-state")) {
        // The read-state GET hangs: the restore decision stays open while the
        // user interacts with the thread.
        return new Promise<Response>((resolve) => { resolveReadState = resolve; });
      }
      if (url.includes("/api/sessions/s1/messages?") && url.includes("before=cursor-old")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u-old", role: "user", content: [{ type: "text", text: "Old question" }] },
            { id: "a-old", role: "assistant", content: [{ type: "text", text: "Old answer" }] },
          ],
          next_cursor: null, has_more: false, snapshot_version: "2:2",
        }));
      }
      return null;
    });

    // Fake timers pin the entry bottom-snap's programmatic-scroll grace
    // (400ms) open, so the wheel below provably lands INSIDE the window where
    // its scroll events are swallowed as programmatic and the scroll handler
    // alone could not cancel a late restore.
    vi.useFakeTimers();
    try {
      renderPage();
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      const scrollerEl = scroller();
      // A real wheel over the scroller is manual user intent even inside the
      // grace window (programmatic .scrollTo never emits wheel events).
      fireEvent.wheel(scrollerEl);
      // Mirror the scroll events a real wheel produces: inside the grace they
      // are treated as part of the programmatic scroll, so they are NOT the
      // mechanism that cancels the restore — the wheel listener is.
      fireEvent.scroll(scrollerEl);
      // The late read-state response carries a saved older anchor.
      await act(async () => {
        resolveReadState(jsonResponse({
          session_id: "s1", anchor_message_id: "u-old", at_bottom: false,
          seen_snapshot_version: null, updated_at: "now", anchor_available: true, before: "cursor-old",
        }));
        await vi.advanceTimersByTimeAsync(10);
      });
      // The restore must NOT start: no older-page load, no anchor scroll, no
      // anchor mount.
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("before=cursor-old"))).toBe(false);
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
      expect(document.getElementById("user-msg-u-old")).not.toBeInTheDocument();
      // The restore decision released the write suppression: the viewport's
      // current anchor persists instead of being dropped.
      const scrollerWithGeo = scrollerWithGeometry();
      scrollerWithGeo.scrollTop = 100;
      driveActiveAnchor("u-old");
      await act(async () => { await vi.advanceTimersByTimeAsync(450); });
      const put = fetchMock.mock.calls.find(([url, init]) => init?.method === "PUT" && String(url).includes("/api/sessions/s1/read-state"));
      expect(put).toBeTruthy();
      expect(String(put![1]?.body)).toContain('"anchor_message_id":"u-old"');
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restore when the user selects a nav item while the read state is still loading", async () => {
    threadWith([userBlock("u-latest", "Latest question"), agentBlock("a-latest", "latest reply")]);
    allRoleIndex([
      { id: "u-old", role: "user", text: "Old question", before: "cursor-old" },
      { id: "a-old", role: "assistant", text: "Old answer", before: "cursor-old" },
      { id: "u-latest", role: "user", text: "Latest question", before: "cursor-latest" },
    ]);
    let resolveReadState: (value: Response) => void = () => {};
    overrides.push((url) => {
      if (url.startsWith("/api/sessions/s1/read-state")) {
        return new Promise<Response>((resolve) => { resolveReadState = resolve; });
      }
      if (url.includes("/api/sessions/s1/messages?") && url.includes("before=cursor-old")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u-old", role: "user", content: [{ type: "text", text: "Old question" }] },
            { id: "a-old", role: "assistant", content: [{ type: "text", text: "Old answer" }] },
          ],
          next_cursor: null, has_more: false, snapshot_version: "2:2",
        }));
      }
      return null;
    });

    await renderReady();
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The user clicks the rail entry for the newest message while the
    // read-state GET is still in flight. u-latest is already loaded, so the
    // nav action direct-scrolls to it (exactly one scrollIntoView).
    fireEvent.click(screen.getByRole("button", { name: "Latest question" }));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    // The late read-state response carries a saved older anchor.
    await act(async () => {
      resolveReadState(jsonResponse({
        session_id: "s1", anchor_message_id: "u-old", at_bottom: false,
        seen_snapshot_version: null, updated_at: "now", anchor_available: true, before: "cursor-old",
      }));
    });
    // The restore must NOT start: no older-page load, no additional scroll.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("before=cursor-old"))).toBe(false);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.getElementById("user-msg-u-old")).not.toBeInTheDocument();
    // The nav action released the write suppression: a viewport change now
    // persists the current anchor.
    driveActiveAnchor("u-old");
    await expectAnchorWrite("u-old");
  });

  it("does not restore when the active anchor changes while the read state is still loading", async () => {
    threadWith([userBlock("u-latest", "Latest question"), agentBlock("a-latest", "latest reply")]);
    allRoleIndex([
      { id: "u-old", role: "user", text: "Old question", before: "cursor-old" },
      { id: "a-old", role: "assistant", text: "Old answer", before: "cursor-old" },
      { id: "u-latest", role: "user", text: "Latest question", before: "cursor-latest" },
    ]);
    let resolveReadState: (value: Response) => void = () => {};
    overrides.push((url) => {
      if (url.startsWith("/api/sessions/s1/read-state")) {
        return new Promise<Response>((resolve) => { resolveReadState = resolve; });
      }
      if (url.includes("/api/sessions/s1/messages?") && url.includes("before=cursor-old")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u-old", role: "user", content: [{ type: "text", text: "Old question" }] },
            { id: "a-old", role: "assistant", content: [{ type: "text", text: "Old answer" }] },
          ],
          next_cursor: null, has_more: false, snapshot_version: "2:2",
        }));
      }
      return null;
    });

    await renderReady();
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The user scrolled such that the old message occupies the viewport top.
    // The scroll event itself is the user signal that supersedes the restore;
    // the rail's active-anchor report that follows is not one (the rail
    // reports nothing until geometry establishes the first entry).
    const scrollerEl = scrollerWithGeometry();
    scrollerEl.scrollTop = 100;
    fireEvent.scroll(scrollerEl);
    driveActiveAnchor("u-old");

    // The late read-state response carries the same older anchor.
    await act(async () => {
      resolveReadState(jsonResponse({
        session_id: "s1", anchor_message_id: "u-old", at_bottom: false,
        seen_snapshot_version: null, updated_at: "now", anchor_available: true, before: "cursor-old",
      }));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The restore must NOT start or yank the viewport back.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("before=cursor-old"))).toBe(false);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(document.getElementById("user-msg-u-old")).not.toBeInTheDocument();
    // The restore decision released the write suppression: the user scrolls
    // on to another message (the old anchor leaves the viewport band, so the
    // rail reports the new active message) and the new anchor persists.
    const io = IOStub.instances.at(-1)!;
    if (io.root instanceof Element) applyGeometry(io.root as HTMLElement);
    act(() => {
      io.cb([
        { target: { id: "user-msg-u-old" }, isIntersecting: false, intersectionRatio: 0 },
        { target: { id: "user-msg-u-latest" }, isIntersecting: true, intersectionRatio: 1 },
      ] as unknown as IntersectionObserverEntry[], io as unknown as IntersectionObserver);
    });
    await expectAnchorWrite("u-latest");
  });

  it("re-registers the rail observer when the restore mounts paginated anchors", async () => {
    // The all-role index already lists u-old up front (it carries a `before`
    // cursor), so the rail's item signature is final before the anchor page
    // loads. Only the loaded-user-anchor key changes when the restore mounts
    // the older page; without it the rail would never observe u-old's anchor.
    threadWith([userBlock("u-latest", "Latest question"), agentBlock("a-latest", "latest reply")]);
    allRoleIndex([
      { id: "u-old", role: "user", text: "Old question", before: "cursor-old" },
      { id: "a-old", role: "assistant", text: "Old answer", before: "cursor-old" },
      { id: "u-latest", role: "user", text: "Latest question", before: "cursor-latest" },
    ]);
    overrides.push((url) => {
      if (url.startsWith("/api/sessions/s1/read-state")) {
        return Promise.resolve(jsonResponse({
          session_id: "s1", anchor_message_id: "u-old", at_bottom: false,
          seen_snapshot_version: null, updated_at: "now", anchor_available: true, before: "cursor-old",
        }));
      }
      if (url.includes("/api/sessions/s1/messages?") && url.includes("before=cursor-old")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u-old", role: "user", content: [{ type: "text", text: "Old question" }] },
            { id: "a-old", role: "assistant", content: [{ type: "text", text: "Old answer" }] },
          ],
          next_cursor: null, has_more: false, snapshot_version: "2:2",
        }));
      }
      return null;
    });

    await renderReady();
    await waitFor(() => expect(document.getElementById("user-msg-u-old")).toBeInTheDocument());
    // The last observer registration (or its DOM-settle re-check) must
    // include the anchor the restore just mounted — re-registration driven by
    // the loaded-user key, not by the unchanged item signature.
    await waitFor(() => {
      const railIo = IOStub.instances.at(-1)!;
      expect(railIo.targets.map((target) => target.id)).toEqual(
        expect.arrayContaining(["user-msg-u-latest", "user-msg-u-old"]),
      );
    });
  });

  /** Poll `getCount` until it has stayed unchanged for `windowMs` (bounded),
   *  then return the settled value. Used to prove a retry loop stopped. */
  async function stableCount(getCount: () => number, windowMs: number, timeoutMs = 5000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let previous = getCount();
    let stableSince = Date.now();
    while (Date.now() - stableSince < windowMs && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = getCount();
      if (current !== previous) {
        previous = current;
        stableSince = Date.now();
      }
    }
    return previous;
  }

  /** Apply the fake viewport geometry both geometry-sensitive handlers read
   *  (the rail's IO callback and the page's active-change handler). */
  function applyGeometry(element: HTMLElement, scrollTop = 100) {
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(element, "clientHeight", { configurable: true, value: 400 });
    element.scrollTop = scrollTop;
  }

  /** Drive the rail's intersection observer to report `anchorId` as the
   *  active viewport message (jsdom has no real IO; geometry must be set on
   *  the scroller first so the near-bottom guard lets the write through).
   *  react-virtuoso can re-create the scroller node in jsdom mid-test, so the
   *  rail's captured root and the page's scroller ref can diverge: mirror the
   *  geometry on the observed root as well. */
  function driveActiveAnchor(anchorId: string) {
    const io = IOStub.instances.at(-1)!;
    if (io.root instanceof Element) applyGeometry(io.root as HTMLElement);
    act(() => {
      io.cb([{
        target: { id: `user-msg-${anchorId}` },
        isIntersecting: true,
        intersectionRatio: 1,
      }] as unknown as IntersectionObserverEntry[], io as unknown as IntersectionObserver);
    });
  }

  /** Common "restore stuck retrying" setup: the saved anchor lives in an
   *  older page that never loads, so the restore keeps retrying every 250ms
   *  until a user action supersedes it. `extraIndex` entries (e.g. a bookmark
   *  jump target) are inserted between the restore anchor and the newest
   *  message. Returns the cursor-old request counter. */
  function stuckRestoreSetup(extraIndex: Array<{ id: string; role: string; text: string; before: string }> = []): () => number {
    threadWith([userBlock("u-latest", "Latest question"), agentBlock("a-latest", "latest reply")]);
    allRoleIndex([
      { id: "u-old", role: "user", text: "Old question", before: "cursor-old" },
      ...extraIndex,
      { id: "u-latest", role: "user", text: "Latest question", before: "cursor-latest" },
    ]);
    let pageLoads = 0;
    overrides.push((url) => {
      if (url.startsWith("/api/sessions/s1/read-state")) {
        return Promise.resolve(jsonResponse({
          session_id: "s1", anchor_message_id: "u-old", at_bottom: false,
          seen_snapshot_version: null, updated_at: "now", anchor_available: true, before: "cursor-old",
        }));
      }
      if (String(url).includes("/api/sessions/s1/messages?") && String(url).includes("before=cursor-old")) {
        pageLoads += 1;
        return Promise.resolve(jsonResponse({ messages: [], next_cursor: null, has_more: false, snapshot_version: "2:2" }));
      }
      return null;
    });
    return () => pageLoads;
  }

  function scrollerWithGeometry(): HTMLElement {
    const element = scroller();
    applyGeometry(element);
    return element;
  }

  function expectAnchorWrite(anchorId: string) {
    return waitFor(() => {
      const put = fetchMock.mock.calls.find(([url, init]) => init?.method === "PUT" && String(url).includes("/api/sessions/s1/read-state"));
      expect(put).toBeTruthy();
      expect(String(put![1]?.body)).toContain(`"anchor_message_id":"${anchorId}"`);
    });
  }

  it("cancels the restore retry loop and releases viewport writes when a nav item is selected", async () => {
    const cursorOldLoads = stuckRestoreSetup();
    await renderReady();
    await waitFor(() => expect(cursorOldLoads()).toBeGreaterThanOrEqual(1));

    fireEvent.click(screen.getByRole("button", { name: "Latest question" }));
    // The restore's retry timers are cancelled and in-flight continuations
    // bail: the cursor-old request count settles and stays put well past one
    // retry interval.
    const settled = await stableCount(cursorOldLoads, 400);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(cursorOldLoads()).toBe(settled);

    // The nav action released the restore's write suppression: a viewport
    // active-change now persists the anchor instead of being dropped.
    const scrollerEl = scrollerWithGeometry();
    scrollerEl.scrollTop = 100;
    driveActiveAnchor("u-old");
    await expectAnchorWrite("u-old");
  });

  it("cancels the restore and releases viewport writes when a bookmark jump supersedes it", async () => {
    const cursorOldLoads = stuckRestoreSetup([{ id: "u-mid", role: "user", text: "Middle question", before: "cursor-mid" }]);
    overrides.push((url) => {
      if (String(url).includes("/api/bookmarks")) {
        return Promise.resolve(jsonResponse({
          bookmarks: [{
            bookmark_id: "b-mid", session_id: "s1", message_id: "u-mid", role: "user",
            quote: "Middle question", label: "mid jump", origin: "user", status: "accepted",
            created_at: "now", updated_at: "now",
          }],
          legacy_skipped: 0,
        }));
      }
      if (String(url).includes("/api/sessions/s1/messages?") && String(url).includes("before=cursor-mid")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u-mid", role: "user", content: [{ type: "text", text: "Middle question" }] },
            { id: "a-mid", role: "assistant", content: [{ type: "text", text: "Middle answer" }] },
          ],
          next_cursor: null, has_more: false, snapshot_version: "2:2",
        }));
      }
      return null;
    });

    await renderReady();
    await waitFor(() => expect(cursorOldLoads()).toBeGreaterThanOrEqual(1));
    fireEvent.click(screen.getByRole("button", { name: "Bookmarks" }));
    fireEvent.click(await screen.findByRole("button", { name: /Jump to message/ }));

    // The jump's own cursor-mid page loads and mounts its anchor…
    await waitFor(() => expect(document.getElementById("user-msg-u-mid")).toBeInTheDocument());
    // …while the restore's cursor-old retry loop has been cancelled.
    const settled = await stableCount(cursorOldLoads, 400);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(cursorOldLoads()).toBe(settled);
    // …and the jump released the restore's write suppression.
    const scrollerEl = scrollerWithGeometry();
    scrollerEl.scrollTop = 100;
    driveActiveAnchor("u-old");
    await expectAnchorWrite("u-old");
  });

  it("cancels the restore retry loop and releases viewport writes when the user wheels after the restore started", async () => {
    const cursorOldLoads = stuckRestoreSetup();
    await renderReady();
    // The restore HAS started: its retry loop is live and the anchor page is
    // still pending. A wheel over the scroller after that point must cancel
    // the in-flight restore exactly like the explicit superseding actions.
    await waitFor(() => expect(cursorOldLoads()).toBeGreaterThanOrEqual(1));

    fireEvent.wheel(scrollerWithGeometry());
    // The restore's retry timers are cancelled and in-flight continuations
    // bail: the cursor-old request count settles and stays put well past one
    // retry interval.
    const settled = await stableCount(cursorOldLoads, 400);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(cursorOldLoads()).toBe(settled);

    // The wheel released the restore's write suppression: a viewport
    // active-change now persists the anchor instead of being dropped.
    const scrollerEl = scrollerWithGeometry();
    scrollerEl.scrollTop = 100;
    driveActiveAnchor("u-old");
    await expectAnchorWrite("u-old");
  });

  it("cancels the restore, releases viewport writes and snaps to newest content when the user sends", async () => {
    const cursorOldLoads = stuckRestoreSetup();
    await renderReady();
    await waitFor(() => expect(cursorOldLoads()).toBeGreaterThanOrEqual(1));

    const scrollerEl = scrollerWithGeometry();
    fireEvent.change(textarea(), { target: { value: "hello" } });
    fireEvent.click(sendButton());
    // The optimistic user block lands (send superseded the restore): the
    // viewport snaps to the newest content because follow-output is back on.
    act(() => {
      const state = useRuntimeStore.getState();
      useRuntimeStore.setState({
        thread: {
          blocks: [...state.thread.blocks, userBlock("u-live", "hello")],
          index: { ...state.thread.index, "u-live": state.thread.blocks.length },
          loaded: true,
        },
      });
    });
    expect(scrollerEl.scrollTop).toBe(1000);

    // The restore's retry loop is cancelled…
    const settled = await stableCount(cursorOldLoads, 400);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(cursorOldLoads()).toBe(settled);
    // …and its write suppression was released.
    scrollerEl.scrollTop = 100;
    driveActiveAnchor("u-old");
    await expectAnchorWrite("u-old");
  });

  it("cancels the restore and releases viewport writes when back-to-latest is clicked", async () => {
    const cursorOldLoads = stuckRestoreSetup();
    await renderReady();
    await waitFor(() => expect(cursorOldLoads()).toBeGreaterThanOrEqual(1));

    // Scroll up so the back-to-latest affordance appears.
    const scrollerEl = scrollerWithGeometry();
    scrollerEl.scrollTop = 100;
    fireEvent.scroll(scrollerEl);
    await waitFor(() => expect(screen.getByLabelText("Back to latest")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Back to latest"));
    expect(scrollerEl.scrollTop).toBe(1000);

    // The restore's retry loop is cancelled…
    const settled = await stableCount(cursorOldLoads, 400);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(cursorOldLoads()).toBe(settled);
    // …and its write suppression was released.
    scrollerEl.scrollTop = 100;
    driveActiveAnchor("u-old");
    await expectAnchorWrite("u-old");
  });

  it("re-asserts follow-output false on every restore retry pass", async () => {
    const cursorOldLoads = stuckRestoreSetup();
    await renderReady();
    await waitFor(() => expect(cursorOldLoads()).toBeGreaterThanOrEqual(1));

    // The restore is retrying when the initial bottom-snap scroll event lands:
    // it re-enables follow-output (the race the reviewer flagged).
    const scrollerEl = scrollerWithGeometry();
    scrollerEl.scrollTop = 1000;
    fireEvent.scroll(scrollerEl);
    // A retry pass runs every 250ms and must re-assert follow-output false.
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Park mid-thread: with follow-output on, the next block append would snap
    // the viewport back to the bottom and virtualize the anchor away.
    scrollerEl.scrollTop = 100;
    act(() => {
      const state = useRuntimeStore.getState();
      useRuntimeStore.setState({
        thread: {
          blocks: [...state.thread.blocks, userBlock("u-live", "Latest live question")],
          index: { ...state.thread.index, "u-live": state.thread.blocks.length },
          loaded: true,
        },
      });
    });
    expect(scrollerEl.scrollTop).toBe(100);
  });
});

describe("bookmark suggestion flow", () => {
  it("suggests bookmarks and accepts a proposal through the panel", async () => {
    // Minimal stateful server: propose creates a proposal row, accept flips it
    // to accepted, list returns the current records.
    const server: Array<Record<string, unknown>> = [];
    overrides.push((url, init) => {
      const method = (init.method || "GET").toUpperCase();
      if (method === "GET" && url.startsWith("/api/bookmarks")) {
        return Promise.resolve(jsonResponse({ bookmarks: server, legacy_skipped: 0 }));
      }
      if (method === "POST" && url.startsWith("/api/bookmarks/propose")) {
        const proposal = {
          bookmark_id: "p1",
          session_id: SESSION_ID,
          message_id: "a1",
          role: "assistant",
          quote: "final result verified",
          label: null,
          origin: "agent_proposal",
          status: "proposed",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        };
        server.push(proposal);
        return Promise.resolve(jsonResponse({ session_id: SESSION_ID, bookmarks: [proposal], skipped: 0 }));
      }
      if (method === "PATCH" && url.startsWith("/api/bookmarks/")) {
        const id = String(url).match(/\/api\/bookmarks\/([^?]+)/)?.[1];
        const record = server.find((entry) => entry.bookmark_id === id);
        if (record) {
          record.status = "accepted";
          record.updated_at = "2026-01-01T00:00:01.000Z";
        }
        return Promise.resolve(jsonResponse({ bookmark: record }));
      }
      return null;
    });
    await renderReady();

    fireEvent.click(screen.getByRole("button", { name: "Bookmarks" }));
    const panel = await screen.findByRole("region", { name: "Bookmarks" });
    fireEvent.click(within(panel).getByRole("button", { name: "Suggest bookmarks" }));

    // The propose POST fires exactly once and the refreshed list shows the
    // proposal row with created-feedback.
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) => init?.method === "POST" && String(url).startsWith("/api/bookmarks/propose"))).toBe(true);
    });
    const accept = await within(panel).findByRole("button", { name: "Accept" });
    expect(server).toHaveLength(1);
    expect(server[0]?.status).toBe("proposed");
    expect(within(panel).getByText(/Added 1 suggestion/i)).toBeInTheDocument();

    // Manual acceptance: the user must click Accept; the server record only
    // moves to accepted through the PATCH.
    fireEvent.click(accept);
    await waitFor(() => expect(server[0]?.status).toBe("accepted"));
    await waitFor(() => expect(within(panel).queryByRole("button", { name: "Accept" })).not.toBeInTheDocument());
    expect(within(panel).getByRole("button", { name: "Remove bookmark" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url, init]) => init?.method === "PATCH" && String(url).startsWith("/api/bookmarks/p1"))).toBe(true);
  });
});

describe("re-entering a session with a saved anchor (real connect)", () => {
  // The reload/re-entry scenario from the browser UAT: a previous entry
  // cached the NEWEST page in localStorage, so the re-entry's connect renders
  // the cached snapshot while its turn-artifacts read is in flight. The
  // reading-position restore must not load the older anchor page into that
  // empty/cached thread window and then get it clobbered by the connect's
  // cached render + newest-page merge — the target would never enter the
  // thread and the restore loop (already done, anchorMounted) would never
  // bring it back.
  function newestPageMessages() {
    return [
      { id: "a3", role: "assistant", content: [{ type: "text", text: "Newest answer 3" }] },
      { id: "u3", role: "user", content: [{ type: "text", text: "Newest question 3" }] },
      { id: "a4", role: "assistant", content: [{ type: "text", text: "Newest answer 4" }] },
      { id: "u4", role: "user", content: [{ type: "text", text: "Newest question 4" }] },
    ];
  }
  function olderPageMessages() {
    return [
      { id: "u1", role: "user", content: [{ type: "text", text: "Old question 1" }] },
      { id: "a1", role: "assistant", content: [{ type: "text", text: "Old answer 1" }] },
      { id: "u2", role: "user", content: [{ type: "text", text: "Old question 2 (anchor)" }] },
      { id: "a2", role: "assistant", content: [{ type: "text", text: "Old answer 2" }] },
    ];
  }

  function seedCachedNewestPage() {
    const storage = new Map<string, string>();
    storage.set("pi-science.msg-cache", JSON.stringify({
      [`${CWD}\u0000${SESSION_ID}`]: { messages: newestPageMessages(), cachedAt: Date.now() },
    }));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    });
  }

  it("keeps the navigation-loaded older page when the re-entry connect resolves from the cached snapshot", async () => {
    seedCachedNewestPage();
    vi.stubGlobal("EventSource", FakeEventSource);
    useRuntimeStore.setState({
      connect: realConnect,
      disconnect: realDisconnect,
      cwd: CWD,
      activeSessionId: null,
      sessions: [{ id: SESSION_ID, cwd: CWD, name: "Session" }],
      thread: { blocks: [], index: {}, loaded: true },
      historyLoading: false,
      status: "ready",
      working: false,
    });
    overrides.push((url) => {
      const path = String(url);
      if (path.startsWith("/api/sessions/s1/read-state")) {
        return Promise.resolve(jsonResponse({
          session_id: SESSION_ID, anchor_message_id: "u2", at_bottom: false,
          seen_snapshot_version: null, updated_at: "now", anchor_available: true, before: "cursor-old",
        }));
      }
      if (path.startsWith("/api/sessions/s1/messages/index")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u1", role: "user", text: "Old question 1", before: "cursor-old" },
            { id: "u2", role: "user", text: "Old question 2 (anchor)", before: "cursor-old" },
            { id: "u3", role: "user", text: "Newest question 3" },
            { id: "u4", role: "user", text: "Newest question 4" },
          ],
          snapshot_version: "1:1",
        }));
      }
      if (path.includes("/api/sessions/s1/messages?") && path.includes("before=cursor-old")) {
        return Promise.resolve(jsonResponse({
          messages: olderPageMessages(),
          next_cursor: null, has_more: false, snapshot_version: "2:2",
        }));
      }
      if (path.includes("/api/sessions/s1/messages?")) {
        // The newest page lands AFTER the cached render window so the restore
        // can slip its older-page load into the empty-thread gap.
        return new Promise((resolve) => setTimeout(() => resolve(jsonResponse({
          messages: newestPageMessages(),
          next_cursor: null, has_more: false, snapshot_version: "3:3",
        })), 450));
      }
      if (path.includes("/api/sessions/s1/state")) {
        return new Promise((resolve) => setTimeout(() => resolve(jsonResponse({
          ok: true,
          id: SESSION_ID,
          cwd: CWD,
          is_streaming: false,
          is_compacting: false,
          pending_message_count: 0,
          model: "custom-custom-api/gpt-5.6-luna",
          thinking: "max",
          context_tokens: 24000,
          context_window: 128000,
          context_percent: 18.75,
          compaction_enabled: true,
          compaction_threshold_percent: 85,
        })), 450));
      }
      if (path.includes("/api/sessions/s1/artifacts")) {
        // Widens the cached-snapshot render window inside connect: while it is
        // in flight, historyLoading is still false on the buggy ordering. The
        // window must outlive the restore's first anchor-mount check so the
        // connect's cached render + merge clobber the older page AFTER the
        // restore loop has already finished (anchorMounted) — the real-browser
        // failure shape.
        return new Promise((resolve) => setTimeout(() => resolve(jsonResponse({ turns: [] })), 400));
      }
      return null;
    });

    await renderReady();
    // The connect's cached render + turn-artifacts chain + newest-page merge
    // take ~1.3s to settle; wait past that before asserting the final thread.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const thread = useRuntimeStore.getState().thread;
    expect(thread.blocks.map((block) => block.id)).toEqual(["u1", "a1", "u2", "a2", "a3", "u3", "a4", "u4"]);
    // The saved anchor must be in the loaded thread (and stay mountable), not
    // dropped by the concurrent newest-page connect.
    expect(thread.index["u2"]).not.toBeUndefined();

    // Cleanup: tear down the real client so its stream/watchdog cannot leak
    // into later tests, and drop the seeded localStorage cache.
    useRuntimeStore.getState().client?.disconnect();
    clearCachedMessages(CWD, SESSION_ID);
  });

  it("gates navigation history loads behind the newest page even when the cached snapshot renders first", async () => {
    seedCachedNewestPage();
    vi.stubGlobal("EventSource", FakeEventSource);
    useRuntimeStore.setState({
      connect: realConnect,
      disconnect: realDisconnect,
      cwd: CWD,
      activeSessionId: null,
      sessions: [{ id: SESSION_ID, cwd: CWD, name: "Session" }],
      thread: { blocks: [], index: {}, loaded: true },
      historyLoading: false,
      status: "ready",
      working: false,
    });
    // The first history navigation request must be gated behind the newest
    // page: it may only START after the newest-page response has resolved, so
    // its prepend can never be clobbered by the connect's cached render +
    // newest-page merge.
    let newestResolvedAt = Number.POSITIVE_INFINITY;
    let firstOlderLoadAt = Number.POSITIVE_INFINITY;
    const startedAt = Date.now();
    overrides.push((url) => {
      const path = String(url);
      if (path.startsWith("/api/sessions/s1/read-state")) {
        return Promise.resolve(jsonResponse({
          session_id: SESSION_ID, anchor_message_id: "u2", at_bottom: false,
          seen_snapshot_version: null, updated_at: "now", anchor_available: true, before: "cursor-old",
        }));
      }
      if (path.startsWith("/api/sessions/s1/messages/index")) {
        return Promise.resolve(jsonResponse({
          messages: [
            { id: "u1", role: "user", text: "Old question 1", before: "cursor-old" },
            { id: "u2", role: "user", text: "Old question 2 (anchor)", before: "cursor-old" },
            { id: "u3", role: "user", text: "Newest question 3" },
            { id: "u4", role: "user", text: "Newest question 4" },
          ],
          snapshot_version: "1:1",
        }));
      }
      if (path.includes("/api/sessions/s1/messages?") && path.includes("before=cursor-old")) {
        if (firstOlderLoadAt === Number.POSITIVE_INFINITY) firstOlderLoadAt = Date.now() - startedAt;
        return Promise.resolve(jsonResponse({
          messages: olderPageMessages(),
          next_cursor: null, has_more: false, snapshot_version: "2:2",
        }));
      }
      if (path.includes("/api/sessions/s1/messages?")) {
        return new Promise((resolve) => setTimeout(() => {
          newestResolvedAt = Date.now() - startedAt;
          resolve(jsonResponse({
            messages: newestPageMessages(),
            next_cursor: null, has_more: false, snapshot_version: "3:3",
          }));
        }, 450));
      }
      if (path.includes("/api/sessions/s1/state")) {
        return new Promise((resolve) => setTimeout(() => resolve(jsonResponse({
          ok: true,
          id: SESSION_ID,
          cwd: CWD,
          is_streaming: false,
          is_compacting: false,
          pending_message_count: 0,
          model: "custom-custom-api/gpt-5.6-luna",
          thinking: "max",
          context_tokens: 24000,
          context_window: 128000,
          context_percent: 18.75,
          compaction_enabled: true,
          compaction_threshold_percent: 85,
        })), 450));
      }
      if (path.includes("/api/sessions/s1/artifacts")) {
        // Widens the cached-snapshot render window inside connect: on the
        // buggy ordering this window had historyLoading still false, letting
        // the restore's older-page load start before the newest page landed.
        return new Promise((resolve) => setTimeout(() => resolve(jsonResponse({ turns: [] })), 400));
      }
      return null;
    });

    await renderReady();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(firstOlderLoadAt).toBeLessThan(Number.POSITIVE_INFINITY);
    expect(firstOlderLoadAt).toBeGreaterThan(newestResolvedAt);

    // Cleanup: tear down the real client so its stream/watchdog cannot leak
    // into later tests, and drop the seeded localStorage cache.
    useRuntimeStore.getState().client?.disconnect();
    clearCachedMessages(CWD, SESSION_ID);
  });
});
