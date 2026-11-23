import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { SidebarMainArea } from "../../components/sidebar/SidebarMainArea";
import userEvent from "@testing-library/user-event";
import { ProjectsLayout } from "./ProjectsLayout";
import { WorkspaceSessionList } from "../../components/sidebar/WorkspaceSessionList";
import { useWorkspaceSidebar } from "../../components/sidebar/workspace-navigation";
import { useUiStore } from "../../lib/ui";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { FeedbackContext } from "../../components/feedback/feedback-context";
import { WorkspaceProvider } from "../../lib/workspace";
import i18n from "../../i18n";
import type { SessionInfo } from "../../lib/client/types";

const pendingKnowledge = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../lib/memory", () => ({ useMemorySummary: () => ({ data: { pendingCount: pendingKnowledge.count } }) }));

vi.mock("../../components/sidebar/FileBrowser", () => ({ FileBrowser: () => <span>Embedded file tree</span> }));
vi.mock("../../components/inspector/InspectorTabs", () => ({ InspectorTabs: () => <button>Inspector control</button> }));

function SidebarFixture() {
  return <SidebarMainArea cwd="proj" renderSessions={query => <WorkspaceSessionList cwd="proj" query={query} />} />;
}

function LocationProbe() {
  const location = useLocation();
  return <><span data-testid="path">{location.pathname}</span><span data-testid="location-state">{JSON.stringify(location.state)}</span></>;
}

function NavigationButton({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(to)}>{label}</button>;
}

function session(id: string, name: string): SessionInfo {
  return { id, cwd: "proj", name, updated_at: new Date().toISOString() };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  cleanup();
  pendingKnowledge.count = 0;
  useWorkspaceSidebar.setState({ cwd: null, tab: "sessions", query: "" });
  useUiStore.setState({ settingsOpen: false, settingsScope: null, contextPanelCollapsed: false, sidebarWidth: 240 });
  useRuntimeStore.setState({
    sessions: [],
    sessionsHasMore: false,
    sessionsLoading: false,
    loadMoreSessions: vi.fn(async () => 0),
    activeSessionId: null,
    cwd: "proj",
    loadSessions: vi.fn(async () => []),
    deleteSession: vi.fn(async () => undefined),
    createNewSession: vi.fn(async () => "created"),
    forkSession: vi.fn(async () => "forked"),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderWorkspaceShell(initialEntry = "/workspace/proj/runs") {
  return render(<FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}><MemoryRouter initialEntries={[initialEntry]}><Routes><Route path="/" element={<span data-testid="projects-home">Projects home</span>} /><Route path="/workspace/:cwd" element={<WorkspaceProvider><ProjectsLayout /></WorkspaceProvider>}><Route index element={<LocationProbe />} /><Route path="new" element={<LocationProbe />} /><Route path="session/:sessionId" element={<LocationProbe />} /><Route path="research" element={<LocationProbe />} /><Route path="runs" element={<LocationProbe />} /><Route path="memory" element={<LocationProbe />} /><Route path="files" element={<LocationProbe />} /></Route></Routes></MemoryRouter></FeedbackContext.Provider>);
}

describe("single workspace sidebar", () => {
  it("uses one sidebar with a project switcher and text navigation", async () => {
    const { container } = renderWorkspaceShell();
    expect(await screen.findByRole("button", { name: "Switch project" })).toHaveTextContent("proj");
    expect(container.querySelector("[data-workspace-rail-slot]")).toBeNull();
    expect(await screen.findByRole("button", { name: "New conversation" })).toHaveClass("bg-accent-fill");
    expect(screen.getByRole("link", { name: "Run history" })).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByRole("button", { name: "Settings" })).toHaveLength(1);
  });

  it("collapses to one explicit toggle and restores the same sidebar", async () => {
    const { container } = renderWorkspaceShell();
    fireEvent.click(await screen.findByRole("button", { name: "Collapse sidebar" }));
    expect(container.querySelector("aside")).toHaveAttribute("hidden");
    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    fireEvent.click(expand);
    expect(container.querySelector("aside")).not.toHaveAttribute("hidden");
    expect(screen.getByRole("button", { name: "Switch project" })).toBeInTheDocument();
  });

  it("opens a durable blank URL without clearing the conversation search", async () => {
    renderWorkspaceShell("/workspace/proj/session/s1");
    fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "history" } });
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(screen.getByTestId("path")).toHaveTextContent("/workspace/proj/new");
    expect(screen.getByRole("searchbox")).toHaveValue("history");
  });
});

describe("WorkspaceSessionList", () => {
  // The real layout stays mounted across /workspace/:cwd ↔
  // /workspace/:cwd/session/:id navigation (the session list lives in the
  // layout, the route only swaps the Outlet content), so both routes render
  // the list next to a path probe — exactly like the production tree.
  function renderList(initialEntry = "/workspace/proj/session/s1", confirm = async () => true) {
    return render(
      <FeedbackContext.Provider value={{ toast: vi.fn(), confirm }}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route
              path="/workspace/:cwd"
              element={<><SidebarFixture /><LocationProbe /></>}
            />
            <Route
              path="/workspace/:cwd/session/:sessionId"
              element={<><SidebarFixture /><LocationProbe /></>}
            />
            <Route
              path="/workspace/:cwd/new"
              element={<><SidebarFixture /><LocationProbe /></>}
            />
            <Route
              path="/workspace/:cwd/files"
              element={<><SidebarFixture /><LocationProbe /></>}
            />
          </Routes>
        </MemoryRouter>
      </FeedbackContext.Provider>,
    );
  }

  function rowFor(name: string): HTMLElement {
    const button = screen.getByRole("button", { name });
    const row = button.closest("div.group");
    if (!row) throw new Error(`session row for ${name} not found`);
    return row as HTMLElement;
  }

  async function deleteConversation(name: string) {
    await userEvent.click(screen.getByRole("button", { name: `Manage conversation: ${name}` }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete conversation" }));
  }

  it("marks the active session with an accent dot and hides the placeholder dots", () => {
    useRuntimeStore.setState({ sessions: [session("s1", "Session A"), session("s2", "Session B")], activeSessionId: "s1" });
    renderList();

    const activeDot = rowFor("Session A").querySelector("span[aria-hidden]");
    expect(activeDot?.className).toContain("bg-accent");
    const inactiveDot = rowFor("Session B").querySelector("span[aria-hidden]");
    expect(inactiveDot?.className).not.toContain("bg-accent");
    expect(inactiveDot?.className).toContain("bg-transparent");
    expect(rowFor("Session A")).toHaveClass("bg-surface-selected");
    expect(screen.getByRole("button", { name: "Session A" })).toHaveAttribute("aria-current", "page");
  });

  it("runtime connected session on Runs has a dot but no URL-current selection", async () => { useRuntimeStore.setState({ sessions: [session("s1", "Session A")], activeSessionId: "s1" }); renderWorkspaceShell(); const button = await screen.findByRole("button", { name: "Session A" }); expect(button).not.toHaveAttribute("aria-current"); expect(button).not.toHaveClass("font-medium"); expect(rowFor("Session A")).not.toHaveClass("bg-surface-selected"); expect(rowFor("Session A").querySelector("span[aria-hidden]")).toHaveClass("bg-accent"); expect(screen.getByRole("link", { name: "Run history" })).toHaveAttribute("aria-current", "page"); });

  it("URL-current session selects independently from the runtime connection", () => { useRuntimeStore.setState({ sessions: [session("s1", "Session A"), session("s2", "Session B")], activeSessionId: "s2" }); renderList(); expect(screen.getByRole("button", { name: "Session A" })).toHaveAttribute("aria-current", "page"); expect(rowFor("Session A")).toHaveClass("bg-surface-selected"); expect(rowFor("Session A").querySelector("span[aria-hidden]")).toHaveClass("bg-transparent"); expect(screen.getByRole("button", { name: "Session B" })).not.toHaveAttribute("aria-current"); expect(rowFor("Session B")).not.toHaveClass("bg-surface-selected"); expect(rowFor("Session B").querySelector("span[aria-hidden]")).toHaveClass("bg-accent"); });

  it("confirms deletion with FeedbackProvider and leaves sessions intact on cancel", async () => { const confirm = vi.fn(async () => false); useRuntimeStore.setState({ sessions: [session("s1", "Session A")], activeSessionId: "s1" }); renderList("/workspace/proj/session/s1", confirm); await deleteConversation("Session A"); expect(confirm).toHaveBeenCalledWith({ title: "Delete conversation", message: "“Session A” will be permanently deleted. This cannot be undone.", confirmLabel: "Delete", destructive: true }); expect(useRuntimeStore.getState().deleteSession).toHaveBeenCalledTimes(0); expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/session/s1"); expect(screen.getByRole("button", { name: "Session A" })).toBeInTheDocument(); });

  it("abandons a confirmed delete when the workspace switched while the dialog was open", async () => {
    let approve: (value: boolean) => void = () => undefined;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => { approve = resolve; }));
    useRuntimeStore.setState({ sessions: [session("s1", "Session A")], activeSessionId: "s1" });
    renderList("/workspace/proj/session/s1", confirm);
    await deleteConversation("Session A");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(useRuntimeStore.getState().deleteSession).toHaveBeenCalledTimes(0);
    // The confirmation dialog lives outside the router, so it survives the switch.
    useRuntimeStore.setState({ cwd: "other", sessions: [session("b1", "Session B")], activeSessionId: null });
    await act(async () => { approve(true); });
    expect(useRuntimeStore.getState().deleteSession).toHaveBeenCalledTimes(0);
  });

  it("renders every loaded page and offers loading for older conversations", () => {
    const loadMoreSessions = vi.fn(async () => 0);
    useRuntimeStore.setState({
      sessions: Array.from({ length: 35 }, (_, index) => session(`s${index}`, `Session ${index}`)),
      sessionsHasMore: true,
      sessionsLoading: false,
      loadMoreSessions,
    });
    renderList();

    expect(screen.getByRole("button", { name: "Session 34" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load older conversations" }));
    expect(loadMoreSessions).toHaveBeenCalledTimes(1);
  });

  it("does not load sessions for a workspace route other than the root", () => {
    const loadSessions = vi.fn(async () => []);
    useRuntimeStore.setState({ loadSessions });
    renderList("/workspace/proj/files");

    expect(loadSessions).not.toHaveBeenCalled();
  });

  it("loads sessions for a direct conversation route when the list is empty", async () => {
    const loadSessions = vi.fn(async () => [session("s1", "Session A")]);
    useRuntimeStore.setState({ sessions: [], activeSessionId: "s1", loadSessions });
    renderList("/workspace/proj/session/s1");

    await waitFor(() => expect(loadSessions).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/session/s1");
  });

  it("does not reload sessions when navigating from the root to a workspace page", async () => {
    const loadSessions = vi.fn(async () => []);
    useRuntimeStore.setState({ loadSessions });
    render(
      <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
        <MemoryRouter initialEntries={["/workspace/proj"]}>
          <Routes>
            <Route
              path="/workspace/:cwd"
              element={<><SidebarFixture /><NavigationButton to="/workspace/proj/files" label="Go files" /><LocationProbe /></>}
            />
            <Route
              path="/workspace/:cwd/files"
              element={<><SidebarFixture /><LocationProbe /></>}
            />
          </Routes>
        </MemoryRouter>
      </FeedbackContext.Provider>,
    );

    await waitFor(() => expect(loadSessions).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Go files" }));
    expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/files");
    expect(loadSessions).toHaveBeenCalledTimes(1);
  });

  it("lands on the blank workspace after deleting the active session without creating a new one", async () => {
    const loadSessions = vi.fn(async () => [session("s2", "Session B")]);
    useRuntimeStore.setState({
      sessions: [session("s1", "Session A"), session("s2", "Session B")],
      activeSessionId: "s1",
      loadSessions,
      deleteSession: vi.fn(async () => {
        useRuntimeStore.setState({ sessions: [session("s2", "Session B")], activeSessionId: null });
      }),
    });
    renderList();

    await deleteConversation("Session A");

    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/workspace/proj"));
    expect(screen.getByTestId("location-state").textContent).toBe('{"landingIntent":{"kind":"active-session-deleted","cwd":"proj"}}');
    const createNewSession = useRuntimeStore.getState().createNewSession as ReturnType<typeof vi.fn>;
    expect(createNewSession).not.toHaveBeenCalled();
    expect(loadSessions).not.toHaveBeenCalled();
    // Other sessions still exist, but the suppression keeps the landing blank
    // (no auto-nav pull-back into the most recent session).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId("path").textContent).toBe("/workspace/proj");
    expect(screen.getByRole("button", { name: "Session B" })).toBeInTheDocument();
  });

  it("auto-opens the most recent session on a normal first entry to the workspace root", async () => {
    useRuntimeStore.setState({
      sessions: [],
      activeSessionId: null,
      loadSessions: vi.fn(async () => [session("s1", "Session A"), session("s2", "Session B")]),
    });
    render(
      <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
        <MemoryRouter initialEntries={["/workspace/proj"]}>
          <Routes>
            <Route path="/workspace/:cwd" element={<><SidebarFixture /><LocationProbe /></>} />
            <Route path="/workspace/:cwd/session/:sessionId" element={<><SidebarFixture /><LocationProbe /></>} />
          </Routes>
        </MemoryRouter>
      </FeedbackContext.Provider>,
    );

    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/session/s1"));
  });

  it("keeps the blank landing after New Session instead of bouncing to the latest session", async () => {
    const loadSessions = vi.fn(async () => [session("s1", "Session A"), session("s2", "Session B")]);
    useRuntimeStore.setState({
      sessions: [session("s1", "Session A"), session("s2", "Session B")],
      activeSessionId: null,
      loadSessions,
    });
    renderList();

    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));

    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/new"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/new");
  });

  it("renders one prominent New conversation action in the sidebar", () => {
    useRuntimeStore.setState({ sessions: [session("s1", "Session A")], activeSessionId: "s1" });
    renderList();

    const button = screen.getByRole("button", { name: "New conversation" });
    expect(button).toHaveClass("bg-accent-fill", "text-accent-fg");
    expect(screen.getAllByRole("button", { name: "New conversation" })).toHaveLength(1);
  });

  it("reveals session actions when the row receives keyboard focus", () => {
    useRuntimeStore.setState({ sessions: [session("s1", "Session A")], activeSessionId: "s1" });
    renderList();

    const row = rowFor("Session A");
    expect(row.className).toContain("focus-within:bg-surface-hover");
    const menuButton = screen.getByRole("button", { name: "Manage conversation: Session A" });
    expect(menuButton.className).toContain("group-focus-within:opacity-100");
  });

  it("does not let a repeated New Session click at root suppress the next normal root entry", async () => {
    const loadSessions = vi.fn(async () => []);
    useRuntimeStore.setState({
      sessions: [session("s1", "Session A")],
      activeSessionId: null,
      loadSessions,
    });
    render(
      <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
        <MemoryRouter initialEntries={["/workspace/proj"]}>
          <NavigationButton to="/" label="Go projects" />
          <NavigationButton to="/workspace/proj" label="Go workspace" />
          <Routes>
            <Route path="/" element={<LocationProbe />} />
            <Route path="/workspace/:cwd" element={<><SidebarFixture /><LocationProbe /></>} />
            <Route path="/workspace/:cwd/new" element={<><SidebarFixture /><LocationProbe /></>} />
          </Routes>
        </MemoryRouter>
      </FeedbackContext.Provider>,
    );

    await waitFor(() => expect(loadSessions).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));

    fireEvent.click(screen.getByRole("button", { name: "Go projects" }));
    expect(screen.getByTestId("path").textContent).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: "Go workspace" }));

    await waitFor(() => expect(loadSessions).toHaveBeenCalledTimes(2));
  });

  it("uses concise search copy without weakening the loaded-only accessible label", () => {
    renderList();
    const search = screen.getByRole("searchbox", { name: "Search loaded conversations" });
    expect(search).toHaveAttribute("placeholder", "Search conversations…");
    expect(search).toHaveAttribute("aria-describedby");
    expect(search.closest("label")).toHaveClass("bg-surface-2");
  });

  it("keeps sessions mounted while switching tabs and applies search to loaded pages", async () => {
    const loadSessions = vi.fn(async () => []);
    useRuntimeStore.setState({ sessions: [session("s1", "Protein study"), session("s2", "Genome study")], activeSessionId: "s1", sessionsHasMore: true, loadSessions });
    renderList();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Protein" } });
    expect(screen.queryByRole("button", { name: "Genome study" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Search covers loaded conversations only;/)).toHaveLength(2);
    const row = screen.getByRole("button", { name: "Protein study" });
    await userEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(row).toBeInTheDocument();
    expect(row.closest('[role="tabpanel"]')).toHaveAttribute("hidden");
    expect(await screen.findByText("Embedded file tree")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Conversations" }));
    expect(screen.getByRole("button", { name: "Protein study" })).toBe(row);
    expect(loadSessions).not.toHaveBeenCalled();
    act(() => useRuntimeStore.setState({ sessions: [...useRuntimeStore.getState().sessions, session("s3", "Protein follow-up")] }));
    expect(screen.getByRole("button", { name: "Protein follow-up" })).toBeInTheDocument();
  });

  it("navigates from the file tab and closes the narrow drawer", async () => {
    vi.stubGlobal("innerWidth", 375);
    useUiStore.setState({ contextPanelCollapsed: false });
    renderList();
    await userEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.click(screen.getByRole("button", { name: /View all files/ }));
    expect(screen.getByTestId("path")).toHaveTextContent("/workspace/proj/files");
    expect(useUiStore.getState().contextPanelCollapsed).toBe(true);
  });

  it("supports keyboard menu navigation, Escape focus return, and fork", async () => {
    useRuntimeStore.setState({ sessions: [session("s1", "Session A")], activeSessionId: "s1" });
    renderList();
    const trigger = screen.getByRole("button", { name: "Manage conversation: Session A" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: "Rename conversation" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Regenerate title with AI" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Delete conversation" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    // Fork sits third, after rename and regenerate: reopen, move twice, activate.
    await userEvent.keyboard("{Enter}{ArrowDown}{ArrowDown}{Enter}");
    await waitFor(() => expect(useRuntimeStore.getState().forkSession).toHaveBeenCalledWith("s1"));
    // Calling the async fork action precedes its resolved result and navigation.
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/workspace/proj/session/forked"));
  });

  it("does not replace Runs after an in-flight connected-session delete", async () => { let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); useRuntimeStore.setState({ sessions: [session("s1", "Session A"), session("s2", "Session B")], activeSessionId: "s1", deleteSession: vi.fn(async () => { await gate; useRuntimeStore.setState({ sessions: [session("s2", "Session B")], activeSessionId: null }); }) }); renderWorkspaceShell("/workspace/proj/session/s1"); await screen.findByRole("button", { name: "Session A" }); await deleteConversation("Session A"); await userEvent.click(screen.getByRole("link", { name: "Run history" })); await act(async () => { release(); await gate; }); expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/runs"); expect(screen.getByTestId("location-state").textContent).toBe("null"); });

  it("does not kick the user out of a session they opened while the delete was in flight", async () => {
    let releaseDelete!: () => void;
    const gate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    useRuntimeStore.setState({
      sessions: [session("s1", "Session A"), session("s2", "Session B")],
      activeSessionId: "s1",
      deleteSession: vi.fn(async () => {
        await gate;
        useRuntimeStore.setState({ sessions: [session("s2", "Session B")], activeSessionId: "s2" });
      }),
    });
    renderList();

    await deleteConversation("Session A");
    // The delete is in flight; the user switches to the other session.
    fireEvent.click(screen.getByRole("button", { name: "Session B" }));
    expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/session/s2");

    await act(async () => {
      releaseDelete();
      await gate;
    });

    // Still on the session the user switched to — no landing, no new session.
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/workspace/proj/session/s2"));
    const createNewSession = useRuntimeStore.getState().createNewSession as ReturnType<typeof vi.fn>;
    expect(createNewSession).not.toHaveBeenCalled();
  });
});

describe("ProjectsLayout workbench navigation", () => {
  it("hides the sidebar on the home page and restores it when entering a workspace", async () => {
    useUiStore.setState({ contextPanelCollapsed: false, inspectorOpen: false, inspectorTabs: [] });
    const { container } = render(
      <FeedbackContext.Provider value={{ toast: vi.fn(), confirm: async () => true }}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<WorkspaceProvider><ProjectsLayout /></WorkspaceProvider>}>
              <Route index element={<NavigationButton to="/workspace/proj" label="Enter workspace" />} />
            </Route>
            <Route path="/workspace/:cwd" element={<WorkspaceProvider><ProjectsLayout /></WorkspaceProvider>}>
              <Route index element={<NavigationButton to="/" label="Return home" />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </FeedbackContext.Provider>,
    );
    expect(container.querySelector("aside")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enter workspace" }));
    await waitFor(() => expect(container.querySelector("aside")).toBeInTheDocument());
    expect(await screen.findByRole("tab", { name: i18n.t("nav.files") })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Return home" }));
    expect(container.querySelector("aside")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Primary navigation" })).toBeNull();
  });
});
